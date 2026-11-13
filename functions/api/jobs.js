// functions/api/jobs.js
// 일반 회원 및 관리자 모두에게 공고 목록이 100% 정상 출력되도록 보강한 통합 API

async function ensureTables(db) {
  // 개별 실행으로 묶어 특정 쿼리 하나가 실패해도 전체가 멈추지 않도록 안전 처리
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      company TEXT,
      title TEXT,
      region TEXT,
      deadline TEXT,
      url TEXT,
      status TEXT,
      appliedDate TEXT,
      memo TEXT,
      history TEXT,
      createdAt TEXT,
      created_by TEXT
    )`).run();
  } catch (e) {}

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

  try { await db.prepare(`ALTER TABLE jobs ADD COLUMN created_by TEXT`).run(); } catch (e) {}
  try { await db.prepare(`ALTER TABLE jobs ADD COLUMN createdAt TEXT`).run(); } catch (e) {}
}

async function handleRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const method = request.method;
  const action = url.searchParams.get('action');
  const userId = url.searchParams.get('userId') || '';

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    await ensureTables(db);

    // ==================== [1. 조회 (GET)] ====================
    if (method === 'GET') {
      // 관리자 전용 데이터 조회
      if (action === 'admin_data') {
        const adminCheck = await db.prepare(`SELECT role FROM users WHERE id = ?`).bind(userId).first();
        if (!adminCheck || adminCheck.role !== 'admin') {
          return new Response(JSON.stringify({ error: '관리자 권한이 필요합니다.' }), { status: 403, headers });
        }
        const { results: users } = await db.prepare(
          `SELECT id, username, nickname, role, status, invite_code, group_name, created_at FROM users ORDER BY created_at DESC`
        ).all();
        const { results: codes } = await db.prepare(
          `SELECT * FROM invite_codes ORDER BY created_at DESC`
        ).all();
        return new Response(JSON.stringify({ users: users || [], codes: codes || [] }), { headers });
      }

      // 전체 공고 목록 조회 (ORDER BY 에러 방지를 위해 기본 SELECT 수행)
      let jobsRaw = [];
      try {
        const resJobs = await db.prepare(`SELECT * FROM jobs`).all();
        jobsRaw = resJobs.results || [];
      } catch (e) {
        jobsRaw = [];
      }

      // 기존 단일 사용자 시절 공고의 상태값을 관리자('admin-1') 개인 기록으로 안전하게 백업
      for (const jb of jobsRaw) {
        if (jb.status || jb.appliedDate || jb.memo) {
          try {
            await db.prepare(`INSERT OR IGNORE INTO user_job_status (user_id, job_id, status, applied_date, memo, updated_at) VALUES ('admin-1', ?, ?, ?, ?, ?)`)
              .bind(jb.id, jb.status || '관심', jb.appliedDate || '', jb.memo || '', new Date().toISOString().slice(0, 10))
              .run();
          } catch (e) {}
        }
      }

      // 모든 회원의 공고별 상태 조회
      let allStatuses = [];
      try {
        const resStatus = await db.prepare(`SELECT user_id, job_id, status, applied_date, memo FROM user_job_status`).all();
        allStatuses = resStatus.results || [];
      } catch (e) {
        allStatuses = [];
      }

      // 로그인한 회원의 개인 기업 태그 조회
      let myTags = {};
      if (userId) {
        try {
          const { results: tagRows } = await db.prepare(`SELECT company, tag FROM user_company_tags WHERE user_id = ?`).bind(userId).all();
          (tagRows || []).forEach(r => { myTags[r.company] = r.tag; });
        } catch (e) {}
      }

      // 공고별 익명 카운트(관심/지원) 집계 및 현재 로그인한 회원의 개인 상태 매핑
      const countsMap = {};
      const myStatusMap = {};

      allStatuses.forEach(row => {
        if (!countsMap[row.job_id]) {
          countsMap[row.job_id] = { interest: 0, applied: 0 };
        }
        if (row.status === '관심' || row.status === '서류작성중') {
          countsMap[row.job_id].interest += 1;
        } else if (row.status === '지원완료' || row.status === '1차면접' || row.status === '최종합격') {
          countsMap[row.job_id].applied += 1;
        }
        if (userId && row.user_id === userId) {
          myStatusMap[row.job_id] = row;
        }
      });

      const enrichedJobs = jobsRaw.map(j => {
        let parsedHistory = [];
        try {
          parsedHistory = j.history ? JSON.parse(j.history) : [];
        } catch (e) {
          parsedHistory = [];
        }

        const myData = myStatusMap[j.id];
        const counts = countsMap[j.id] || { interest: 0, applied: 0 };

        // 로그인한 회원은 본인이 설정한 상태(없으면 기본 '관심')가 보이고, 메모도 본인 것만 보임
        const resolvedStatus = userId ? (myData ? myData.status : '관심') : (j.status || '관심');
        const resolvedAppliedDate = userId ? (myData ? (myData.applied_date || '') : '') : (j.appliedDate || '');
        const resolvedMemo = userId ? (myData ? (myData.memo || '') : '') : (j.memo || '');

        return {
          ...j,
          id: j.id,
          company: j.company || '',
          title: j.title || '',
          region: j.region || '수원시',
          deadline: j.deadline || '채용시마감',
          url: j.url || '',
          createdBy: j.created_by || '관리자',
          status: resolvedStatus,
          appliedDate: resolvedAppliedDate,
          memo: resolvedMemo,
          interestCount: counts.interest,
          appliedCount: counts.applied,
          history: parsedHistory
        };
      });

      if (!url.searchParams.has('userId')) {
        return new Response(JSON.stringify(enrichedJobs), { headers });
      }
      return new Response(JSON.stringify({ jobs: enrichedJobs, companyTags: myTags }), { headers });
    }

    // ==================== [2. 등록 / 로그인 / 관리 (POST)] ====================
    if (method === 'POST') {
      const body = await request.json();

      // (A) 로그인
      if (action === 'login') {
        const { username, password } = body;
        const user = await db.prepare(`SELECT * FROM users WHERE username = ? AND password = ?`)
          .bind((username || '').trim(), (password || '').trim())
          .first();

        if (!user) {
          return new Response(JSON.stringify({ error: '아이디 또는 비밀번호가 일치하지 않습니다.' }), { status: 401, headers });
        }
        if (user.status === 'pending') {
          return new Response(JSON.stringify({ error: '현재 관리자 가입 승인 대기 중입니다. 승인 후 이용 가능합니다.' }), { status: 403, headers });
        }
        if (user.status === 'blocked' || user.status === 'rejected') {
          return new Response(JSON.stringify({ error: '접속이 제한된 계정입니다.' }), { status: 403, headers });
        }

        return new Response(JSON.stringify({
          user: {
            id: user.id,
            username: user.username,
            nickname: user.nickname,
            role: user.role,
            groupName: user.group_name
          }
        }), { headers });
      }

      // (B) 초대코드 회원가입 신청
      if (action === 'register') {
        const { username, password, nickname, inviteCode } = body;
        const cleanCode = (inviteCode || '').trim().toUpperCase();

        const codeRow = await db.prepare(`SELECT * FROM invite_codes WHERE code = ? AND is_active = 1`).bind(cleanCode).first();
        if (!codeRow) {
          return new Response(JSON.stringify({ error: '유효하지 않거나 존재하지 않는 초대코드입니다.' }), { status: 400, headers });
        }

        const existingUser = await db.prepare(`SELECT id FROM users WHERE username = ?`).bind((username || '').trim()).first();
        if (existingUser) {
          return new Response(JSON.stringify({ error: '이미 사용 중인 아이디입니다.' }), { status: 400, headers });
        }

        const newUserId = 'user-' + Date.now();
        const today = new Date().toISOString().slice(0, 10);

        await db.prepare(`INSERT INTO users (id, username, password, nickname, role, status, invite_code, group_name, created_at) VALUES (?, ?, ?, ?, 'member', 'pending', ?, ?, ?)`)
          .bind(newUserId, username.trim(), password.trim(), nickname.trim(), cleanCode, codeRow.group_name, today)
          .run();

        return new Response(JSON.stringify({
          success: true,
          message: `'${codeRow.group_name}' 그룹으로 가입 신청이 완료되었습니다! 관리자 허가 후 로그인이 가능합니다.`
        }), { headers });
      }

      // (C) 관리자: 초대코드 생성
      if (action === 'create_invite') {
        const { adminId, groupName, customCode } = body;
        const adminCheck = await db.prepare(`SELECT role FROM users WHERE id = ?`).bind(adminId).first();
        if (!adminCheck || adminCheck.role !== 'admin') {
          return new Response(JSON.stringify({ error: '관리자 권한이 없습니다.' }), { status: 403, headers });
        }

        const randomChars = Math.random().toString(36).substring(2, 6).toUpperCase();
        const code = (customCode && customCode.trim()) ? customCode.trim().toUpperCase() : `GH-${randomChars}`;
        const today = new Date().toISOString().slice(0, 10);

        await db.prepare(`INSERT OR REPLACE INTO invite_codes (code, group_name, is_active, created_at) VALUES (?, ?, 1, ?)`)
          .bind(code, (groupName || '기본 그룹').trim(), today)
          .run();

        return new Response(JSON.stringify({ success: true, code, groupName }), { headers });
      }

      // (D) 관리자: 회원 및 코드 관리
      if (action === 'manage_user') {
        const { adminId, targetUserId, subAction, newPassword, newUsername, newNickname, targetCode } = body;
        const adminCheck = await db.prepare(`SELECT role FROM users WHERE id = ?`).bind(adminId).first();
        if (!adminCheck || adminCheck.role !== 'admin') {
          return new Response(JSON.stringify({ error: '관리자 권한이 없습니다.' }), { status: 403, headers });
        }

        if (subAction === 'approve') {
          await db.prepare(`UPDATE users SET status = 'approved' WHERE id = ?`).bind(targetUserId).run();
        } else if (subAction === 'delete_user') {
          await db.prepare(`DELETE FROM users WHERE id = ? AND role != 'admin'`).bind(targetUserId).run();
          await db.prepare(`DELETE FROM user_job_status WHERE user_id = ?`).bind(targetUserId).run();
          await db.prepare(`DELETE FROM user_company_tags WHERE user_id = ?`).bind(targetUserId).run();
        } else if (subAction === 'reset_pw') {
          await db.prepare(`UPDATE users SET password = ? WHERE id = ?`).bind(newPassword, targetUserId).run();
        } else if (subAction === 'change_account') {
          await db.prepare(`UPDATE users SET username = ?, nickname = ? WHERE id = ?`).bind(newUsername, newNickname, targetUserId).run();
        } else if (subAction === 'delete_code') {
          await db.prepare(`DELETE FROM invite_codes WHERE code = ?`).bind(targetCode).run();
        }

        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // (E) 개인별 기업 태그 저장
      if (action === 'save_tag') {
        const { userId: uId, company, tag } = body;
        if (!uId || !company) return new Response(JSON.stringify({ error: '잘못된 요청' }), { status: 400, headers });

        if (!tag) {
          await db.prepare(`DELETE FROM user_company_tags WHERE user_id = ? AND company = ?`).bind(uId, company).run();
        } else {
          await db.prepare(`INSERT OR REPLACE INTO user_company_tags (user_id, company, tag) VALUES (?, ?, ?)`).bind(uId, company, tag).run();
        }
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // (F) 공통 공고 등록/수정 및 내 개인 상태 저장
      const job = body;
      const historyStr = JSON.stringify(job.history || []);
      const creatorName = job.createdBy || '관리자';

      let existingJob = null;
      try {
        existingJob = await db.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(job.id).first();
      } catch (e) {}

      const finalCreator = (existingJob && existingJob.created_by) ? existingJob.created_by : creatorName;
      const finalCreatedAt = (existingJob && existingJob.createdAt) ? existingJob.createdAt : new Date().toISOString();

      await db.prepare(`
        INSERT OR REPLACE INTO jobs (id, company, title, region, deadline, url, status, appliedDate, memo, history, createdAt, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        job.id,
        job.company,
        job.title,
        job.region,
        job.deadline,
        job.url || '',
        existingJob ? (existingJob.status || '관심') : (job.status || '관심'),
        existingJob ? (existingJob.appliedDate || '') : (job.appliedDate || ''),
        existingJob ? (existingJob.memo || '') : (job.memo || ''),
        historyStr,
        finalCreatedAt,
        finalCreator
      ).run();

      const targetUserId = job.userId || 'admin-1';
      const today = new Date().toISOString().slice(0, 10);
      await db.prepare(`
        INSERT OR REPLACE INTO user_job_status (user_id, job_id, status, applied_date, memo, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        targetUserId,
        job.id,
        job.status || '관심',
        job.appliedDate || '',
        job.memo || '',
        today
      ).run();

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // ==================== [3. 삭제 (DELETE)] ====================
    if (method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (id) {
        await db.prepare(`DELETE FROM jobs WHERE id = ?`).bind(id).run();
        await db.prepare(`DELETE FROM user_job_status WHERE job_id = ?`).bind(id).run();
      }
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    return new Response(JSON.stringify({ error: '허용되지 않는 요청입니다.' }), { status: 405, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

// Cloudflare Pages Functions의 모든 호출 방식을 100% 지원하도록 연결
export async function onRequest(context) { return handleRequest(context); }
export async function onRequestGet(context) { return handleRequest(context); }
export async function onRequestPost(context) { return handleRequest(context); }
export async function onRequestDelete(context) { return handleRequest(context); }
export async function onRequestOptions(context) { return handleRequest(context); }
