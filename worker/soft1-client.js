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
 * Run an ad-hoc SELECT via SqlData. Soft1's SqlData service accepts a SQL
 * expression directly (requires the user have "Execute SQL" rights — the same
 * rights that `x=external`.GetSqlDataSet relies on).
 *
 * Returns the response's `rows` field: an array of plain objects keyed by column.
 */
export async function runSql(env, clientID, sql) {
  const data = await callService(env, {
    service:  'SqlData',
    clientID,
    SqlName:  '',        // empty: inline SQL rather than a stored template
    param1:   sql
  });
  // S1Services returns { success, totalcount, fields, rows }
  // `rows` may be an array of arrays; convert to objects keyed by field name.
  if (!data.rows) return [];
  if (data.fields && Array.isArray(data.rows[0])) {
    return data.rows.map(row => {
      const o = {};
      data.fields.forEach((f, i) => { o[f.name] = row[i]; });
      return o;
    });
  }
  return data.rows;
}

/**
 * Run an UPDATE/INSERT via a server-side JS script (Soft1 "JS" service).
 * The embedded x=external uses RUNSQL; S1Services doesn't expose arbitrary DML,
 * so we route writes through a named Soft1 script that accepts the SQL as a param.
 *
 * You must deploy a Soft1 "JS" script named "RUNSQL" that executes:
 *     try { X.RUNSQL(param1, null); return { success: true }; }
 *     catch (e) { return { success: false, error: e.message }; }
 */
export async function runExec(env, clientID, sql) {
  const data = await callService(env, {
    service:  'JS',
    clientID,
    Script:   'RUNSQL',
    param1:   sql
  });
  return data.success !== false;
}

/**
 * Validate a clientID is still alive by pinging a cheap service.
 */
export async function pingSession(env, clientID) {
  try {
    await callService(env, { service: 'getBrowserInfo', clientID, object: 'CUSTOMER' });
    return true;
  } catch {
    return false;
  }
}
