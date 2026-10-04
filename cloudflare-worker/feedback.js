import {
  cleanText,
  normalizeUsername,
  isAllowedUser,
  jsonResponse,
  gateCall
} from "./shared.js";

const FEEDBACK_VERSION = "feedback-v3-tab-feedback";
const RESEND_API_URL = "https://api.resend.com/emails";
const FEEDBACK_MAX_TEXT_LENGTH = 3000;
const FEEDBACK_KINDS = new Set(["evaluation", "issue"]);
const FEEDBACK_TYPES = new Set(["comment", "bug"]);
const WORKSPACES = Object.freeze({
  general: "General CT Atlas",
  map: "Intelligence Map",
  crypto: "Crypto Intelligence",
  facial: "Facial Intelligence",
  social: "Social Media (Beta)",
  darkweb: "Dark Web Intelligence (Beta)",
  ip: "IP Intelligence"
});
const LEGACY_EVALUATION_ITEMS = [
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

function validRating(raw) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

function normalizeFeedbackType(body) {
  const direct = cleanText(body.feedback_type, 32).toLowerCase();
  if (direct) return direct;
  const category = cleanText(body.category, 80).toLowerCase();
  if (!category) return "";
  return category === "bug" || category.startsWith("bug") ? "bug" : "comment";
}

function buildEmail(username, body) {
  const kind = cleanText(body.kind, 20);
  const submitted = new Date().toISOString();

  // Preserve delivery for older cached Map forms until users reload Main.
  if (kind === "evaluation" && !validRating(body.rating) && body.ratings && typeof body.ratings === "object") {
    const ratings = body.ratings;
    const itemComments = body.item_comments && typeof body.item_comments === "object" ? body.item_comments : {};
    const lines = ["Tester: " + username, "Submitted: " + submitted, ""];
    for (const [key, label] of LEGACY_EVALUATION_ITEMS) {
      const value = Number(ratings[key]);
      lines.push(label + ": " + (value >= 1 && value <= 5 ? value + "/5" : "(not rated)"));
      const comment = cleanText(itemComments[key], FEEDBACK_MAX_TEXT_LENGTH);
      if (comment) lines.push("  Comment: " + comment);
      lines.push("");
    }
    lines.push("Other:");
    lines.push(cleanText(body.other_comments, FEEDBACK_MAX_TEXT_LENGTH) || "(none)");
    return { subject: "CT Atlas feedback -- evaluation from " + username, text: lines.join("\n") };
  }

  if (kind === "issue" && !body.workspace && !body.feedback_type && body.category) {
    const legacyLines = [
      "Tester: " + username,
      "Submitted: " + submitted,
      "",
      "Category: " + cleanText(body.category, 80),
      "",
      "Description:",
      cleanText(body.description, FEEDBACK_MAX_TEXT_LENGTH) || "(none)"
    ];
    return { subject: "CT Atlas feedback -- issue from " + username, text: legacyLines.join("\n") };
  }

  const workspaceKey = cleanText(body.workspace, 32).toLowerCase() || "general";
  const workspace = WORKSPACES[workspaceKey] || WORKSPACES.general;
  const description = cleanText(body.description, FEEDBACK_MAX_TEXT_LENGTH);
  const feedbackType = normalizeFeedbackType(body);
  const hasRating = validRating(body.rating);
  const kindLabel = [];
  if (hasRating) kindLabel.push("evaluation");
  if (description) kindLabel.push(feedbackType === "bug" ? "bug report" : "comment");

  const lines = [
    "Tester: " + username,
    "Submitted: " + submitted,
    "Workspace: " + workspace,
    "Overall rating: " + (hasRating ? Number(body.rating) + "/5" : "(not provided)"),
    "Feedback type: " + (description ? (feedbackType === "bug" ? "Bug report" : "Comment") : "(none)"),
    "",
    "Comment or bug report:",
    description || "(none)"
  ];
  return {
    subject: "CT Atlas feedback -- " + workspace + " -- " + (kindLabel.join(" + ") || "feedback") + " from " + username,
    text: lines.join("\n")
  };
}

async function sendFeedbackEmail(env, subject, text) {
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.RESEND_API_KEY,
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
    throw new Error("Resend error " + response.status + ": " + cleanText(await response.text(), 300));
  }
}

async function handleFeedback(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON request." }, 400, env); }

  const username = normalizeUsername(body.user_id);
  const token = cleanText(request.headers.get("X-Session-Token"), 160);
  const kind = cleanText(body.kind, 20);
  const workspace = cleanText(body.workspace, 32).toLowerCase() || "general";
  const description = cleanText(body.description, FEEDBACK_MAX_TEXT_LENGTH);
  const rawRating = body.rating;
  const ratingProvided = rawRating !== undefined && rawRating !== null && String(rawRating).trim() !== "";
  const ratingValid = ratingProvided && validRating(rawRating);
  const legacyEvaluation = kind === "evaluation" && body.ratings && typeof body.ratings === "object";
  const feedbackType = normalizeFeedbackType(body);

  if (!username) return jsonResponse({ error: "Missing user identifier." }, 400, env);
  if (!isAllowedUser(username, env)) return jsonResponse({ error: "Unknown user." }, 400, env);
  if (!token) return jsonResponse({ error: "Authenticated session required. Please sign in again." }, 401, env);
  if (!FEEDBACK_KINDS.has(kind)) return jsonResponse({ error: "Unsupported feedback type." }, 400, env);
  if (!Object.prototype.hasOwnProperty.call(WORKSPACES, workspace)) return jsonResponse({ error: "Unsupported workspace." }, 400, env);
  if (ratingProvided && !ratingValid) return jsonResponse({ error: "Overall rating must be from 1 to 5." }, 400, env);
  if (kind === "evaluation" && !ratingValid && !legacyEvaluation) return jsonResponse({ error: "Select an overall rating from 1 to 5." }, 400, env);
  if (kind === "issue" && !description) return jsonResponse({ error: "Please describe the issue." }, 400, env);
  if (description && !FEEDBACK_TYPES.has(feedbackType)) return jsonResponse({ error: "Choose comment or bug report." }, 400, env);

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

export { handleFeedback, buildEmail, FEEDBACK_VERSION, validRating };