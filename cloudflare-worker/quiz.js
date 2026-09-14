import {gateCall, jsonResponse, sha256} from './shared.js';
export async function handleQuiz(request, env) {
  const reply = (data, status=200) => {
    const r = jsonResponse(data, status, env);
    r.headers.set('Cache-Control', 'no-store');return r;
  };
  const url = new URL(request.url);
  if (!((url.pathname === '/quiz-state' && request.method === 'GET') ||
        (url.pathname === '/quiz-answer' && request.method === 'POST'))) return reply({error:'Method not allowed.'},405);
  try {
    const token = request.headers.get('X-Session-Token');
    if (!token) return reply({error:'Please sign in again to record your answer.'},401);
    const sr = await gateCall(env, '/session-get', {session_token:token});
    const session = await sr.json();
    if (!sr.ok || !session.username) return reply({error:'Session expired. Please sign in again.'},401);
    let body = {};
    if (request.method === 'POST') {
      try {body = await request.json();} catch {return reply({error:'Invalid JSON.'},400);}
      if (!Number.isInteger(body.selected_index) || body.selected_index < 0 || body.selected_index > 2 || typeof body.quiz_id !== 'string')
        return reply({error:'Invalid choice. Reload this page.'},400);
    }
    const qr = await fetch(env.QUIZ_URL || 'https://ct-atlas.com/daily-quiz.json', {cache:'no-store', signal:AbortSignal.timeout(15000)});
    if (!qr.ok) throw new Error('Quiz unavailable');
    const q = await qr.json();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date) || !q.question || !Array.isArray(q.options) || q.options.length!==3 ||
        !Number.isInteger(q.correct_index) || q.correct_index<0 || q.correct_index>2) throw new Error('Invalid quiz');
    const id = await sha256(JSON.stringify([q.date,q.question,q.options]));
    const payload = {username:session.username, quiz_date:q.date};
    if (request.method === 'GET') {
      const stateResponse = await gateCall(env,'/quiz-state',payload);
      if (!stateResponse.ok) throw new Error('State unavailable');
      const state = await stateResponse.json();
      return reply({quiz:{id,date:q.date,category:q.category,question:q.question,options:q.options}, ...state});
    }
    if (body.quiz_id !== id) return reply({error:'The quiz has changed. Reload the page before answering.'},409);
    const recorded = await gateCall(env, '/quiz-answer-record', {
      ...payload, quiz_id:id, selected_index:body.selected_index,
      correct:body.selected_index===q.correct_index, correct_index:q.correct_index,
      category:q.category, question:q.question, options:q.options,
      source_checked_at:q.source_checked_at,
      explanation:q.explanation, source_url:q.source_url
    });
    return reply(await recorded.json(), recorded.status);
  } catch {
    return reply({error:'Unable to confirm your quiz result. Please retry; only your first recorded answer counts.'},503);
  }
}
