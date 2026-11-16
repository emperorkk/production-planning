/**
 * Soft1 Web Services (S1Services) HTTP client.
 *
 * S1Services is Soft1's built-in REST façade. All calls are POST with a JSON
 * body whose `service` field names the operation. A session is identified by
 * a `clientID` returned from /login and promoted to a session via /authenticate.
 *
 * Reference: https://docs.soft1.gr (Soft1 Services / s1services endpoint).
 */

import { decodeSoft1 } from './encoding.js';

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
  const text = decodeSoft1(await res.arrayBuffer(), res.headers.get('content-type') || '');
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
export async function loginAndAuthenticate(env, { username, password, company, branch, appId }) {
  appId = appId || env.SOFT1_APP_ID;
  if (!appId) throw new Error('SOFT1_APP_ID is not configured');

  // Step 1 — login → temporary clientID + objs[] (allowed COMPANY/BRANCH/MODULE/REFID combos)
  let login;
  try {
    login = await callService(env, {
      service:  'login',
      username,
      password,
      appId
    });
  } catch (e) {
    throw new Error('Soft1 login: ' + e.message);
  }
  const tempClientID = login.clientID;
  if (!tempClientID) throw new Error('Soft1 login: no clientID returned');

  const objs = Array.isArray(login.objs) ? login.objs : [];
  console.log('Soft1 login objs:', JSON.stringify(objs));   // visible in `wrangler tail`; no secrets

  // Pick the objs entry: requested company/branch → env defaults → first offered.
  const wantCo = String(company || env.SOFT1_COMPANY || '');
  const wantBr = String(branch  || env.SOFT1_BRANCH  || '');
  const pick =
    objs.find(o => (!wantCo || String(o.COMPANY) === wantCo) && (!wantBr || String(o.BRANCH) === wantBr)) ||
    objs.find(o => !wantCo || String(o.COMPANY) === wantCo) ||
    objs[0];
  if (!pick) throw new Error('Soft1 login: no company available for this user');

  // Step 2 — authenticate with the values Soft1 offered (REFID/MODULE must match the user)
  const authBody = {
    service:  'authenticate',
    clientID: tempClientID,
    COMPANY:  String(pick.COMPANY),
    BRANCH:   String(pick.BRANCH ?? pick.COMPANY),
    MODULE:   String(pick.MODULE ?? 0),
    REFID:    String(pick.REFID ?? 0)
  };
  let auth;
  try {
    auth = await callService(env, authBody);
  } catch (e) {
    throw new Error('Soft1 authenticate (COMPANY ' + authBody.COMPANY + ', BRANCH ' + authBody.BRANCH +
                    ', REFID ' + authBody.REFID + '): ' + e.message);
  }

  return {
    clientID: auth.clientID || tempClientID,
    company:  parseInt(authBody.COMPANY, 10),
    branch:   parseInt(authBody.BRANCH, 10),
    user:     username,
    objs
  };
}

/**
 * Call a function of the custom Soft1 AJS web service (soft1/Foxline.planning.js).
 *   POST <SOFT1_API_URL>/JS/<SOFT1_JS_SCRIPT>/<fn>   body: { clientID, ...params }
 */
export async function callJS(env, clientID, fn, params = {}) {
  const script = env.SOFT1_JS_SCRIPT || 'Foxline.planning';
  const res = await fetch(endpoint(env, `JS/${script}/${fn}`), {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ clientID, ...params })
  });
  const text = decodeSoft1(await res.arrayBuffer(), res.headers.get('content-type') || '');
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
 * Native S1Services getData — read one record of a Soft1 object.
 *   { service:'getData', clientID, appId, OBJECT, FORM, KEY, LOCATEINFO }
 * Returns the response's `data` ({ TABLE: [ {field: value} ] }).
 */
export async function getRecord(env, clientID, object, key, locateinfo, appId) {
  const data = await callService(env, {
    service:    'getData',
    clientID,
    appId:      appId || env.SOFT1_APP_ID,
    OBJECT:     object,
    FORM:       '',
    KEY:        String(key),
    LOCATEINFO: locateinfo
  });
  return data.data || {};
}

/**
 * Native S1Services setData — update one existing record of a Soft1 object.
 *   { service:'setData', clientID, appId, OBJECT, KEY, data:{ TABLE:[{field: value}] } }
 * Goes through the Soft1 object (its validations / events), not raw SQL.
 */
export async function setRecord(env, clientID, object, key, data, appId) {
  const res = await callService(env, {
    service:  'setData',
    clientID,
    appId:    appId || env.SOFT1_APP_ID,
    OBJECT:   object,
    KEY:      String(key),
    data
  });
  return res;
}

/**
 * Native S1Services changePassword — changes the web user's login password.
 *   { service:'changePassword', clientID, appId, OLD, NEW } → { success: true }
 */
export async function changePassword(env, clientID, oldPassword, newPassword, appId) {
  await callService(env, {
    service:  'changePassword',
    clientID,
    appId:    appId || env.SOFT1_APP_ID,
    OLD:      oldPassword,
    NEW:      newPassword
  });
  return true;
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
