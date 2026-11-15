/**
 * Soft1 Web Services (S1Services) HTTP client.
 *
 * S1Services is Soft1's built-in REST façade. All calls are POST with a JSON
 * body whose `service` field names the operation. A session is identified by
 * a `clientID` returned from /login and promoted to a session via /authenticate.
 *
 * Reference: https://docs.soft1.gr (Soft1 Services / s1services endpoint).
 */

function endpoint(env, path = '') {
  const base = (env.SOFT1_API_URL || '').replace(/\/+$/, '');
  return base + (path ? '/' + path.replace(/^\/+/, '') : '');
}

async function callService(env, body) {
  const res = await fetch(endpoint(env), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('Soft1 non-JSON response: ' + text.slice(0, 200)); }
  if (data.success === false) {
    const msg = data.errorcode ? `Soft1 ${data.errorcode}: ${data.error}` : (data.error || 'Soft1 call failed');
    throw new Error(msg);
  }
  return data;
}

/**
 * Login + authenticate in one flow. Returns { clientID, objs, company, branch, user }.
 *
 * `objs` is the list of modules/menus the user has access to — we persist it so
 * the UI can hide features the user cannot reach.
 */
export async function loginAndAuthenticate(env, { username, password, company, branch }) {
  // Step 1 — login (returns a temporary clientID + list of companies)
  const login = await callService(env, {
    service:  'login',
    username,
    password,
    appId:    env.SOFT1_APP_ID || '703'   // Soft1 default appId is 703
  });
  const tempClientID = login.clientID;
  if (!tempClientID) throw new Error('Login succeeded but no clientID returned');

  // Pick the company/branch. If caller specified, use it. Else pick the first offered.
  const chosenCompany = company || env.SOFT1_COMPANY || (login.objs?.[0]?.COMPANY);
  const chosenBranch  = branch  || env.SOFT1_BRANCH  || (login.objs?.[0]?.BRANCH);
  if (!chosenCompany) throw new Error('No company available for this user');

  // Step 2 — authenticate (promotes clientID into an authenticated session)
  const auth = await callService(env, {
    service:  'authenticate',
    clientID: tempClientID,
    COMPANY:  parseInt(chosenCompany, 10),
    BRANCH:   parseInt(chosenBranch || chosenCompany, 10),
    MODULE:   0,
    REFID:    0
  });

  return {
    clientID: auth.clientID || tempClientID,
    company:  parseInt(chosenCompany, 10),
    branch:   parseInt(chosenBranch || chosenCompany, 10),
    user:     username,
    objs:     login.objs || []
  };
}

/**
 * Call a function of the custom Soft1 AJS web service (soft1/Foxline.planning.js).
 *   POST <SOFT1_API_URL>/JS/<SOFT1_JS_SCRIPT>/<fn>   body: { clientID, ...params }
 */
async function callJS(env, clientID, fn, params = {}) {
  const script = env.SOFT1_JS_SCRIPT || 'Foxline.planning';
  const res = await fetch(endpoint(env, `JS/${script}/${fn}`), {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ clientID, ...params })
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Soft1 ${fn}: non-JSON response: ` + text.slice(0, 200)); }
  return data;
}

/**
 * Call a named dataset of Foxline.planning (GetMachines, GetOrdersInWeek, ...).
 * Returns an array of plain objects keyed by column alias.
 */
export async function getDataset(env, clientID, name, params = {}) {
  const data = await callJS(env, clientID, name, params);
  if (data.success === false) throw new Error(data.error || (name + ' failed'));
  return Array.isArray(data.data) ? data.data : [];
}

/**
 * Write machine + planned dates through Foxline.planning/SaveSchedule.
 * orders: [{ findoc, machine|null, start|null, end|null }]  (dates 'YYYY-MM-DD HH:MM')
 * Returns { success, saved, skipped, errors[] }.
 */
export async function saveSchedule(env, clientID, orders) {
  const data = await callJS(env, clientID, 'SaveSchedule', { orders });
  if (data.success === false && !Array.isArray(data.errors)) {
    throw new Error(data.error || 'SaveSchedule failed');
  }
  return data;
}

/**
 * Validate a clientID is still alive.
 */
export async function pingSession(env, clientID) {
  try {
    const data = await callJS(env, clientID, 'Ping');
    return data.success !== false;
  } catch {
    return false;
  }
}
