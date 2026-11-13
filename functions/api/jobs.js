// functions/api/jobs.js
// 기존 DB 데이터 100% 보존 + 다중 사용자/초대코드/관리자 기능을 자동 세팅하는 통합 API

async function ensureTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
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
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      nickname TEXT,
      role TEXT DEFAULT 'member',
      status TEXT DEFAULT 'pending',
      invite_code TEXT,
      group_name TEXT,
      created_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      group_name TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_job_status (
      user_id TEXT,
      job_id TEXT,
      status TEXT,
      applied_date TEXT,
      memo TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, job_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_company_tags (
      user_id TEXT,
      company TEXT,
      tag TEXT,
      PRIMARY KEY (user_id, company)
    )`),
    db.prepare(`INSERT OR IGNORE INTO users (id, username, password, nickname, role, status, invite_code, group_name, created_at)
      VALUES ('admin-1', 'gh', 'admin1234', 'GH', 'admin', 'approved', 'MASTER', '총괄관리자', '2026-11-13')`)
  ]);

  // 기존 jobs 테이블에 없는 컬럼이 있을 경우 에러 없이 안전하게 추가
  try { await db.prepare(`ALTER TABLE jobs ADD COLUMN created_by TEXT`).run(); } catch (e) {}
  try { await db.prepare(`ALTER TABLE jobs ADD COLUMN createdAt TEXT`).run(); } catch (e) {}
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
    await ensureTables(db);

    // ==================== [1. 조회 (GET)] ====================
    if (method === 'GET') {
      // 관리자 전용: 전체 회원 및 초대코드 목록 조회
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
        return new Response(JSON.stringify({ users, codes }), { headers });
      }

      // 공고 목록 조회 (기존 createdAt 정렬 유지)
      const { results: jobsRaw } = await db.prepare(`SELECT * FROM jobs ORDER BY createdAt DESC`).all();
      const { results: allStatuses } = await db.prepare(`SELECT user_id, job_id, status, applied_date, memo FROM user_job_status`).all();

      // 기존 단일 사용자 시절 저장된 상태값을 관리자('admin-1') 개인 기록으로 자동 백업 이관
      for (const jb of jobsRaw) {
        if (jb.status || jb.appliedDate || jb.memo) {
          await db.prepare(`INSERT OR IGNORE INTO user_job_status (user_id, job_id, status, applied_date, memo, updated_at) VALUES ('admin-1', ?, ?, ?, ?, ?)`)
            .bind(jb.id, jb.status || '관심', jb.appliedDate || '', jb.memo || '', new Date().toISOString().slice(0, 10))
            .run();
        }
      }

      let myTags = {};
      if (userId) {
        const { results: tagRows } = await db.prepare(`SELECT company, tag FROM user_company_tags WHERE user_id = ?`).bind(userId).all();
        tagRows.forEach(r => { myTags[r.company] = r.tag; });
      }

      // 공고별 관심/지원 인원수 익명 집계 및 로그인 유저 상태 매핑
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

        // 아직 2단계(로그인 화면) 적용 전이거나 비로그인일 때는 기존 테이블 값 그대로 표시
        const resolvedStatus = userId ? (myData ? myData.status : '관심') : (j.status || '관심');
        const resolvedAppliedDate = userId ? (myData ? (myData.applied_date || '') : '') : (j.appliedDate || '');
        const resolvedMemo = userId ? (myData ? (myData.memo || '') : '') : (j.memo || '');

        return {
          ...j,
          id: j.id,
          company: j.company,
          title: j.title,
          region: j.region,
          deadline: j.deadline,
          url: j.url,
          createdBy: j.created_by || 'GH',
          status: resolvedStatus,
          appliedDate: resolvedAppliedDate,
          memo: resolvedMemo,
          interestCount: counts.interest,
          appliedCount: counts.applied,
          history: parsedHistory
        };
      });

      // 현재 index.html과 100% 호환 유지
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

      // (C) 관리자: 그룹별 랜덤 초대코드 생성
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

      // (D) 관리자: 회원 승인/탈퇴/비번초기화 및 초대코드 삭제
      if (action === 'manage_user') {
        const { adminId, targetUserId, subAction, newPassword, targetCode } = body;
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
        } else if (subAction === 'delete_code') {
          await db.prepare(`DELETE FROM invite_codes WHERE code = ?`).bind(targetCode).run();
        }

        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // (E) 개인별 기업 풀 태그(✔, ✖, ■) 저장
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

      // (F) 기본: 채용 공고 등록/수정 및 내 개인 상태 저장
      const job = body;
      const historyStr = JSON.stringify(job.history || []);
      const creatorName = job.createdBy || 'GH';

      const existingJob = await db.prepare(`SELECT created_by, createdAt, status, appliedDate, memo FROM jobs WHERE id = ?`).bind(job.id).first();
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
        job.status || (existingJob ? existingJob.status : '관심'),
        job.appliedDate !== undefined ? job.appliedDate : (existingJob ? existingJob.appliedDate : ''),
        job.memo !== undefined ? job.memo : (existingJob ? existingJob.memo : ''),
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
