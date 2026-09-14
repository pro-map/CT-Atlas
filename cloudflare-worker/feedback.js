import {
  cleanText,
  normalizeUsername,
  isAllowedUser,
  jsonResponse,
  gateCall
} from "./shared.js";

// In-app "Send Feedback": evaluation ratings and one-off issue reports are
// relayed straight to the CT Atlas owner's inbox via Resend -- never stored,
// never shown anywhere in the UI. Bump whenever the email SHAPE changes.
const FEEDBACK_VERSION = "feedback-v2-per-item-comments";

const RESEND_API_URL = "https://api.resend.com/emails";
const FEEDBACK_MAX_TEXT_LENGTH = 3000;
const FEEDBACK_KINDS = new Set(["evaluation", "issue"]);
// Every rated item gets its own comment field alongside the 1-5 score, so a
// tester can explain a low score right where they gave it instead of one
// shared free-text box at the end.
const EVALUATION_ITEMS = [
  ["report_generator", "Report Generator"],
  ["deep_search", "Deep Search (BETA)"],
  ["ct_atlas_ai", "CT Atlas AI"],
  ["heat_map", "Heat Map"],
  ["situation_24h", "Situation 24H"],
  ["weekly_analysis", "Weekly Analysis"],
  ["key_developments", "Key Developments"],
  ["database", "Events Database"],
  ["security", "Security Features"]
];

function ratingLine(label, raw) {
  const value = Number(raw);
  return `${label}: ${value >= 1 && value <= 5 ? `${value}/5` : "(not rated)"}`;
}

function buildEmail(username, body) {
  const kind = cleanText(body.kind, 20);
  const submitted = new Date().toISOString();

  if (kind === "evaluation") {
    const ratings = body.ratings && typeof body.ratings === "object" ? body.ratings : {};
    const itemComments = body.item_comments && typeof body.item_comments === "object" ? body.item_comments : {};
    const lines = [
      `Tester: ${username}`,
      `Submitted: ${submitted}`,
      ""
    ];
    for (const [key, label] of EVALUATION_ITEMS) {
      lines.push(ratingLine(label, ratings[key]));
      const comment = cleanText(itemComments[key], FEEDBACK_MAX_TEXT_LENGTH);
      if (comment) lines.push(`  Comment: ${comment}`);
      lines.push("");
    }
    lines.push("Other:");
    lines.push(cleanText(body.other_comments, FEEDBACK_MAX_TEXT_LENGTH) || "(none)");
    return { subject: `CT Atlas feedback -- evaluation from ${username}`, text: lines.join("\n") };
  }

  const lines = [
    `Tester: ${username}`,
    `Submitted: ${submitted}`,
    "",
    `Category: ${cleanText(body.category, 80) || "(none)"}`,
    "",
    "Description:",
    cleanText(body.description, FEEDBACK_MAX_TEXT_LENGTH) || "(none)"
  ];
  return { subject: `CT Atlas feedback -- issue from ${username}`, text: lines.join("\n") };
}

async function sendFeedbackEmail(env, subject, text) {
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "CT Atlas Feedback <onboarding@resend.dev>",
      to: [env.FEEDBACK_TO_EMAIL],
      subject,
      text
    })
  });
  if (!response.ok) {
    throw new Error(`Resend error ${response.status}: ${cleanText(await response.text(), 300)}`);
  }
}

async function handleFeedback(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }

  const username = normalizeUsername(body.user_id);
  const token = cleanText(request.headers.get("X-Session-Token"), 160);
  const kind = cleanText(body.kind, 20);

  if (!username) return jsonResponse({ error: "Missing user identifier." }, 400, env);
  if (!isAllowedUser(username, env)) return jsonResponse({ error: "Unknown user." }, 400, env);
  if (!token) return jsonResponse({ error: "Authenticated session required. Please sign in again." }, 401, env);
  if (!FEEDBACK_KINDS.has(kind)) return jsonResponse({ error: "Unsupported feedback type." }, 400, env);

  if (kind === "issue" && !cleanText(body.description, FEEDBACK_MAX_TEXT_LENGTH)) {
    return jsonResponse({ error: "Please describe the issue." }, 400, env);
  }

  const sessionResponse = await gateCall(env, "/session-get", { session_token: token });
  const session = await sessionResponse.json();
  if (!sessionResponse.ok || session?.username !== username) {
    return jsonResponse({ error: "Unauthorized session." }, 401, env);
  }

  const acquireResponse = await gateCall(env, "/feedback-acquire", { username });
  const acquire = await acquireResponse.json();
  if (!acquireResponse.ok || !acquire?.reservation_id) {
    return jsonResponse({
      error: acquire?.error || "Feedback limit reached.",
      retry_after_seconds: acquire?.retry_after_seconds
    }, acquireResponse.status || 429, env);
  }

  const reservationId = String(acquire.reservation_id);
  const { subject, text } = buildEmail(username, body);

  try {
    await sendFeedbackEmail(env, subject, text);
    const commitResponse = await gateCall(env, "/quota-commit", {
      username,
      kind: "feedback",
      reservation_id: reservationId
    });
    if (!commitResponse.ok) throw new Error("Unable to finalize feedback quota.");
  } catch (error) {
    try {
      await gateCall(env, "/quota-release", {
        username,
        kind: "feedback",
        reservation_id: reservationId
      });
    } catch (releaseError) {
      console.error("Feedback quota release failed", releaseError);
    }
    console.error(error);
    return jsonResponse({ error: "Unable to send feedback right now. Please try again shortly." }, 503, env);
  }

  return jsonResponse({ ok: true }, 200, env);
}

export { handleFeedback, buildEmail, FEEDBACK_VERSION };
