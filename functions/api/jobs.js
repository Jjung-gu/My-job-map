// functions/api/jobs.js
// 아이디/비밀번호/초대코드 대소문자 구분 없이 인식 + 원본 구조 100% 호환 버전

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

async function initMultiUserTables(db) {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      nickname TEXT,
      role TEXT DEFAULT 'member',
      status TEXT DEFAULT 'pending',
      invite_code TEXT,
      group_name TEXT,
      created_at TEXT
    )`).run();
  } catch (e) {}

  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      group_name TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT
    )`).run();
  } catch (e) {}

  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS user_job_status (
      user_id TEXT,
      job_id TEXT,
      status TEXT,
      applied_date TEXT,
      memo TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, job_id)
    )`).run();
  } catch (e) {}

  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS user_company_tags (
      user_id TEXT,
      company TEXT,
      tag TEXT,
      PRIMARY KEY (user_id, company)
    )`).run();
  } catch (e) {}

  try {
    await db.prepare(`INSERT OR IGNORE INTO users (id, username, password, nickname, role, status, invite_code, group_name, created_at)
      VALUES ('admin-1', 'gh', 'admin1234', '관리자', 'admin', 'approved', 'MASTER', '총괄관리자', '2026-11-13')`).run();
  } catch (e) {}
}

// 1. 공고 목록 및 관리자 데이터 조회 (GET)
export async function onRequestGet(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const action = url.searchParams.get("action");
  const userId = url.searchParams.get("userId") || "";

  try {
    await initMultiUserTables(db);

    if (action === "admin_data") {
      const { results: users } = await db.prepare(
        "SELECT id, username, nickname, role, status, invite_code, group_name, created_at FROM users"
      ).all();
      const { results: codes } = await db.prepare(
        "SELECT * FROM invite_codes"
      ).all();
      return new Response(JSON.stringify({ users: users || [], codes: codes || [] }), { headers: CORS_HEADERS });
    }

    let jobsRaw = [];
    try {
      const { results } = await db.prepare("SELECT * FROM jobs ORDER BY createdAt DESC").all();
      jobsRaw = results || [];
    } catch (err1) {
      const { results } = await db.prepare("SELECT * FROM jobs").all();
      jobsRaw = results || [];
    }

    let allStatuses = [];
    try {
      const stRes = await db.prepare("SELECT * FROM user_job_status").all();
      allStatuses = stRes.results || [];
    } catch (e) {}

    let myTags = {};
    if (userId) {
      try {
        const tagRes = await db.prepare("SELECT company, tag FROM user_company_tags WHERE user_id = ?").bind(userId).all();
        (tagRes.results || []).forEach(r => { myTags[r.company] = r.tag; });
      } catch (e) {}
    }

    const countsMap = {};
    const myStatusMap = {};

    allStatuses.forEach(row => {
      if (!countsMap[row.job_id]) countsMap[row.job_id] = { interest: 0, applied: 0 };
      if (row.status === "관심" || row.status === "서류작성중") countsMap[row.job_id].interest += 1;
      else if (row.status === "지원완료" || row.status === "1차면접" || row.status === "최종합격") countsMap[row.job_id].applied += 1;

      if (userId && row.user_id === userId) {
        myStatusMap[row.job_id] = row;
      }
    });

    const formatted = jobsRaw.map(row => {
      let parsedHistory = [];
      try {
        parsedHistory = row.history ? JSON.parse(row.history) : [];
      } catch (e) {
        parsedHistory = [];
      }

      const myData = myStatusMap[row.id];
      const counts = countsMap[row.id] || { interest: 0, applied: 0 };

      const isAdminUser = (!userId || userId === "admin-1");
      const finalStatus = myData ? myData.status : (isAdminUser ? (row.status || "관심") : "관심");
      const finalAppliedDate = myData ? (myData.applied_date || "") : (isAdminUser ? (row.appliedDate || "") : "");
      const finalMemo = myData ? (myData.memo || "") : (isAdminUser ? (row.memo || "") : "");

      let interestCount = counts.interest;
      let appliedCount = counts.applied;
      if (!myStatusMap[row.id] && row.status) {
        if (row.status === "관심" || row.status === "서류작성중") interestCount = Math.max(1, interestCount);
        if (row.status === "지원완료" || row.status === "1차면접" || row.status === "최종합격") appliedCount = Math.max(1, appliedCount);
      }

      return {
        ...row,
        history: parsedHistory,
        status: finalStatus,
        appliedDate: finalAppliedDate,
        memo: finalMemo,
        interestCount,
        appliedCount,
        createdBy: row.created_by || "관리자"
      };
    });

    if (url.searchParams.get("withTags") === "1") {
      return new Response(JSON.stringify({ jobs: formatted, companyTags: myTags }), { headers: CORS_HEADERS });
    }
    return new Response(JSON.stringify(formatted), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

// 2. 공고 등록 / 로그인 / 회원가입 / 관리자 처리 (POST)
export async function onRequestPost(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const action = url.searchParams.get("action");

  try {
    await initMultiUserTables(db);
    const body = await context.request.json();

    // (A) 로그인 (아이디 & 비밀번호 모두 대소문자 구분 없이 비교)
    if (action === "login") {
      const { username, password } = body;
      const cleanUser = (username || "").trim().toLowerCase();
      const cleanPw = (password || "").trim().toLowerCase();

      const user = await db.prepare("SELECT * FROM users WHERE LOWER(username) = ? AND LOWER(password) = ?")
        .bind(cleanUser, cleanPw)
        .first();

      if (!user) {
        return new Response(JSON.stringify({ error: "아이디 또는 비밀번호가 일치하지 않습니다." }), { status: 401, headers: CORS_HEADERS });
      }
      if (user.status === "pending") {
        return new Response(JSON.stringify({ error: "현재 관리자 가입 승인 대기 중입니다." }), { status: 403, headers: CORS_HEADERS });
      }

      return new Response(JSON.stringify({
        user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, groupName: user.group_name }
      }), { headers: CORS_HEADERS });
    }

    // (B) 회원가입 신청 (아이디 중복 체크 및 초대코드 대소문자 무시)
    if (action === "register") {
      const { username, password, nickname, inviteCode } = body;
      const cleanCode = (inviteCode || "").trim().toUpperCase();
      const cleanUser = (username || "").trim().toLowerCase();
      const cleanPw = (password || "").trim().toLowerCase();

      const codeRow = await db.prepare("SELECT * FROM invite_codes WHERE UPPER(code) = ? AND is_active = 1").bind(cleanCode).first();
      if (!codeRow) {
        return new Response(JSON.stringify({ error: "유효하지 않은 초대코드입니다." }), { status: 400, headers: CORS_HEADERS });
      }

      const existingUser = await db.prepare("SELECT id FROM users WHERE LOWER(username) = ?").bind(cleanUser).first();
      if (existingUser) {
        return new Response(JSON.stringify({ error: "이미 사용 중인 아이디입니다." }), { status: 400, headers: CORS_HEADERS });
      }

      await db.prepare("INSERT INTO users (id, username, password, nickname, role, status, invite_code, group_name, created_at) VALUES (?, ?, ?, ?, 'member', 'pending', ?, ?, ?)")
        .bind("user-" + Date.now(), cleanUser, cleanPw, (nickname || "").trim(), cleanCode, codeRow.group_name, new Date().toISOString().slice(0, 10))
        .run();

      return new Response(JSON.stringify({
        success: true,
        message: `'${codeRow.group_name}' 그룹으로 가입 신청이 완료되었습니다! 관리자 승인 후 로그인 가능합니다.`
      }), { headers: CORS_HEADERS });
    }

    // (C) 초대코드 생성
    if (action === "create_invite") {
      const { groupName, customCode } = body;
      const randomChars = Math.random().toString(36).substring(2, 6).toUpperCase();
      const code = (customCode && customCode.trim()) ? customCode.trim().toUpperCase() : `GH-${randomChars}`;
      await db.prepare("INSERT OR REPLACE INTO invite_codes (code, group_name, is_active, created_at) VALUES (?, ?, 1, ?)")
        .bind(code, (groupName || "기본 그룹").trim(), new Date().toISOString().slice(0, 10))
        .run();
      return new Response(JSON.stringify({ success: true, code, groupName }), { headers: CORS_HEADERS });
    }

    // (D) 회원 및 코드 관리 (변경 시에도 소문자 정규화 적용)
    if (action === "manage_user") {
      const { targetUserId, subAction, newPassword, newUsername, newNickname, targetCode } = body;
      if (subAction === "approve") {
        await db.prepare("UPDATE users SET status = 'approved' WHERE id = ?").bind(targetUserId).run();
      } else if (subAction === "delete_user") {
        await db.prepare("DELETE FROM users WHERE id = ? AND role != 'admin'").bind(targetUserId).run();
      } else if (subAction === "reset_pw") {
        await db.prepare("UPDATE users SET password = ? WHERE id = ?").bind((newPassword || "").trim().toLowerCase(), targetUserId).run();
      } else if (subAction === "change_account") {
        await db.prepare("UPDATE users SET username = ?, nickname = ? WHERE id = ?").bind((newUsername || "").trim().toLowerCase(), (newNickname || "").trim(), targetUserId).run();
      } else if (subAction === "delete_code") {
        await db.prepare("DELETE FROM invite_codes WHERE code = ?").bind(targetCode).run();
      }
      return new Response(JSON.stringify({ success: true }), { headers: CORS_HEADERS });
    }

    // (E) 기업 태그 저장
    if (action === "save_tag") {
      const { userId: uId, company, tag } = body;
      if (!tag) await db.prepare("DELETE FROM user_company_tags WHERE user_id = ? AND company = ?").bind(uId, company).run();
      else await db.prepare("INSERT OR REPLACE INTO user_company_tags (user_id, company, tag) VALUES (?, ?, ?)").bind(uId, company, tag).run();
      return new Response(JSON.stringify({ success: true }), { headers: CORS_HEADERS });
    }

    // (F) 기본: 공고 등록 및 수정
    const data = body;
    const historyStr = JSON.stringify(data.history || []);

    try {
      await db.prepare(`
        INSERT OR REPLACE INTO jobs (id, company, title, region, deadline, url, status, appliedDate, memo, history, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT createdAt FROM jobs WHERE id = ?), datetime('now')))
      `).bind(
        data.id, data.company, data.title, data.region, data.deadline,
        data.url || "", data.status || "관심", data.appliedDate || "", data.memo || "", historyStr, data.id
      ).run();
    } catch (errSql) {
      await db.prepare(`
        INSERT OR REPLACE INTO jobs (id, company, title, region, deadline, url, status, appliedDate, memo, history)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        data.id, data.company, data.title, data.region, data.deadline,
        data.url || "", data.status || "관심", data.appliedDate || "", data.memo || "", historyStr
      ).run();
    }

    const targetUserId = data.userId || "admin-1";
    try {
      await db.prepare(`
        INSERT OR REPLACE INTO user_job_status (user_id, job_id, status, applied_date, memo, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(targetUserId, data.id, data.status || "관심", data.appliedDate || "", data.memo || "", new Date().toISOString().slice(0, 10)).run();
    } catch (e) {}

    return new Response(JSON.stringify({ success: true }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}

// 3. 공고 삭제 (DELETE)
export async function onRequestDelete(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");

  try {
    if (id) {
      await db.prepare("DELETE FROM jobs WHERE id = ?").bind(id).run();
      try { await db.prepare("DELETE FROM user_job_status WHERE job_id = ?").bind(id).run(); } catch (e) {}
    }
    return new Response(JSON.stringify({ success: true }), { headers: CORS_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
}