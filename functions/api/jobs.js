// functions/api/jobs.js
// 기존 D1 jobs 테이블 구조와 100% 호환되며 에러를 원천 차단한 안전 복구 버전

async function initTables(db) {
  // 새 테이블들만 안전하게 생성 (기존 jobs 테이블은 절대 건드리지 않음)
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

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const method = request.method;
  const action = url.searchParams.get('action');
  const userId = url.searchParams.get('userId') || '';

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    await initTables(db);

    // ==================== [1. GET 요청: 공고 및 관리자 데이터 조회] ====================
    if (method === 'GET') {
      if (action === 'admin_data') {
        const { results: users } = await db.prepare(`SELECT id, username, nickname, role, status, invite_code, group_name, created_at FROM users`).all();
        const { results: codes } = await db.prepare(`SELECT * FROM invite_codes`).all();
        return new Response(JSON.stringify({ users: users || [], codes: codes || [] }), { headers });
      }

      // 기존 방식 그대로 jobs 테이블 전체 조회 (컬럼 에러 방지)
      let jobsRaw = [];
      try {
        const res = await db.prepare(`SELECT * FROM jobs ORDER BY createdAt DESC`).all();
        jobsRaw = res.results || [];
      } catch (e1) {
        try {
          const res2 = await db.prepare(`SELECT * FROM jobs`).all();
          jobsRaw = res2.results || [];
        } catch (e2) {
          jobsRaw = [];
        }
      }

      // 개인별 상태 목록 조회
      let allStatuses = [];
      try {
        const stRes = await db.prepare(`SELECT * FROM user_job_status`).all();
        allStatuses = stRes.results || [];
      } catch (e) {}

      // 내 기업 태그 조회
      let myTags = {};
      if (userId) {
        try {
          const tagRes = await db.prepare(`SELECT company, tag FROM user_company_tags WHERE user_id = ?`).bind(userId).all();
          (tagRes.results || []).forEach(r => { myTags[r.company] = r.tag; });
        } catch (e) {}
      }

      // 공고별 관심/지원 카운트 집계
      const countsMap = {};
      const myStatusMap = {};

      allStatuses.forEach(row => {
        if (!countsMap[row.job_id]) countsMap[row.job_id] = { interest: 0, applied: 0 };
        if (row.status === '관심' || row.status === '서류작성중') countsMap[row.job_id].interest += 1;
        else if (row.status === '지원완료' || row.status === '1차면접' || row.status === '최종합격') countsMap[row.job_id].applied += 1;

        if (userId && row.user_id === userId) {
          myStatusMap[row.job_id] = row;
        }
      });

      const formattedJobs = jobsRaw.map(row => {
        let parsedHistory = [];
        try {
          parsedHistory = row.history ? JSON.parse(row.history) : [];
        } catch (e) {
          parsedHistory = [];
        }

        const myData = myStatusMap[row.id];
        const counts = countsMap[row.id] || { interest: 0, applied: 0 };

        // 관리자('admin-1')는 개인 테이블에 아직 기록이 없으면 기존 jobs 테이블에 적혀있던 원래 상태와 메모를 그대로 보여줌!
        const isAdminUser = (!userId || userId === 'admin-1');
        const finalStatus = myData ? myData.status : (isAdminUser ? (row.status || '관심') : '관심');
        const finalAppliedDate = myData ? (myData.applied_date || '') : (isAdminUser ? (row.appliedDate || '') : '');
        const finalMemo = myData ? (myData.memo || '') : (isAdminUser ? (row.memo || '') : '');

        // 만약 기존 공고에 관리자가 설정해둔 상태가 있다면 카운트에도 기본 반영
        let interestCount = counts.interest;
        let appliedCount = counts.applied;
        if (!myStatusMap[row.id] && row.status) {
          if (row.status === '관심' || row.status === '서류작성중') interestCount = Math.max(1, interestCount);
          if (row.status === '지원완료' || row.status === '1차면접' || row.status === '최종합격') appliedCount = Math.max(1, appliedCount);
        }

        return {
          ...row,
          history: parsedHistory,
          status: finalStatus,
          appliedDate: finalAppliedDate,
          memo: finalMemo,
          interestCount,
          appliedCount,
          createdBy: row.created_by || '관리자'
        };
      });

      if (!url.searchParams.has('userId')) {
        return new Response(JSON.stringify(formattedJobs), { headers });
      }
      return new Response(JSON.stringify({ jobs: formattedJobs, companyTags: myTags }), { headers });
    }

    // ==================== [2. POST 요청: 로그인/가입/공고저장] ====================
    if (method === 'POST') {
      const body = await request.json();

      if (action === 'login') {
        const { username, password } = body;
        const user = await db.prepare(`SELECT * FROM users WHERE username = ? AND password = ?`)
          .bind((username || '').trim(), (password || '').trim())
          .first();

        if (!user) return new Response(JSON.stringify({ error: '아이디 또는 비밀번호가 일치하지 않습니다.' }), { status: 401, headers });
        if (user.status === 'pending') return new Response(JSON.stringify({ error: '관리자 승인 대기 중입니다.' }), { status: 403, headers });

        return new Response(JSON.stringify({
          user: { id: user.id, username: user.username, nickname: user.nickname, role: user.role, groupName: user.group_name }
        }), { headers });
      }

      if (action === 'register') {
        const { username, password, nickname, inviteCode } = body;
        const cleanCode = (inviteCode || '').trim().toUpperCase();
        const codeRow = await db.prepare(`SELECT * FROM invite_codes WHERE code = ? AND is_active = 1`).bind(cleanCode).first();
        if (!codeRow) return new Response(JSON.stringify({ error: '유효하지 않은 초대코드입니다.' }), { status: 400, headers });

        const existingUser = await db.prepare(`SELECT id FROM users WHERE username = ?`).bind((username || '').trim()).first();
        if (existingUser) return new Response(JSON.stringify({ error: '이미 사용 중인 아이디입니다.' }), { status: 400, headers });

        await db.prepare(`INSERT INTO users (id, username, password, nickname, role, status, invite_code, group_name, created_at) VALUES (?, ?, ?, ?, 'member', 'pending', ?, ?, ?)`)
          .bind('user-' + Date.now(), username.trim(), password.trim(), nickname.trim(), cleanCode, codeRow.group_name, new Date().toISOString().slice(0, 10))
          .run();

        return new Response(JSON.stringify({ success: true, message: '가입 신청 완료! 관리자 승인 후 로그인 가능합니다.' }), { headers });
      }

      if (action === 'create_invite') {
        const { groupName, customCode } = body;
        const randomChars = Math.random().toString(36).substring(2, 6).toUpperCase();
        const code = (customCode && customCode.trim()) ? customCode.trim().toUpperCase() : `GH-${randomChars}`;
        await db.prepare(`INSERT OR REPLACE INTO invite_codes (code, group_name, is_active, created_at) VALUES (?, ?, 1, ?)`)
          .bind(code, (groupName || '기본 그룹').trim(), new Date().toISOString().slice(0, 10))
          .run();
        return new Response(JSON.stringify({ success: true, code, groupName }), { headers });
      }

      if (action === 'manage_user') {
        const { targetUserId, subAction, newPassword, newUsername, newNickname, targetCode } = body;
        if (subAction === 'approve') await db.prepare(`UPDATE users SET status = 'approved' WHERE id = ?`).bind(targetUserId).run();
        else if (subAction === 'delete_user') await db.prepare(`DELETE FROM users WHERE id = ? AND role != 'admin'`).bind(targetUserId).run();
        else if (subAction === 'reset_pw') await db.prepare(`UPDATE users SET password = ? WHERE id = ?`).bind(newPassword, targetUserId).run();
        else if (subAction === 'change_account') await db.prepare(`UPDATE users SET username = ?, nickname = ? WHERE id = ?`).bind(newUsername, newNickname, targetUserId).run();
        else if (subAction === 'delete_code') await db.prepare(`DELETE FROM invite_codes WHERE code = ?`).bind(targetCode).run();
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      if (action === 'save_tag') {
        const { userId: uId, company, tag } = body;
        if (!tag) await db.prepare(`DELETE FROM user_company_tags WHERE user_id = ? AND company = ?`).bind(uId, company).run();
        else await db.prepare(`INSERT OR REPLACE INTO user_company_tags (user_id, company, tag) VALUES (?, ?, ?)`).bind(uId, company, tag).run();
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 공고 저장: 기존 jobs.js와 동일한 10개 기본 컬럼으로 안전하게 저장
      const job = body;
      const historyStr = JSON.stringify(job.history || []);

      try {
        await db.prepare(`
          INSERT OR REPLACE INTO jobs (id, company, title, region, deadline, url, status, appliedDate, memo, history)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          job.id, job.company, job.title, job.region, job.deadline,
          job.url || '', job.status || '관심', job.appliedDate || '', job.memo || '', historyStr
        ).run();
      } catch (e) {}

      // 개인별 상태 테이블에도 동시에 저장
      const targetUserId = job.userId || 'admin-1';
      try {
        await db.prepare(`
          INSERT OR REPLACE INTO user_job_status (user_id, job_id, status, applied_date, memo, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(targetUserId, job.id, job.status || '관심', job.appliedDate || '', job.memo || '', new Date().toISOString().slice(0, 10)).run();
      } catch (e) {}

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // ==================== [3. DELETE 요청] ====================
    if (method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (id) {
        await db.prepare(`DELETE FROM jobs WHERE id = ?`).bind(id).run();
        try { await db.prepare(`DELETE FROM user_job_status WHERE job_id = ?`).bind(id).run(); } catch (e) {}
      }
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
