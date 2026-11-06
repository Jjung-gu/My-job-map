// functions/api/jobs.js

// 1. 공고 목록 조회 (GET)
export async function onRequestGet(context) {
  try {
    const { results } = await context.env.DB.prepare(
      "SELECT * FROM jobs ORDER BY createdAt DESC"
    ).all();

    const formatted = results.map(row => ({
      ...row,
      history: row.history ? JSON.parse(row.history) : []
    }));

    return new Response(JSON.stringify(formatted), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

// 2. 공고 신규 등록 (POST)
export async function onRequestPost(context) {
  try {
    const job = await context.request.json();
    const historyJson = JSON.stringify(job.history || []);

    await context.env.DB.prepare(
      `INSERT INTO jobs (id, company, title, region, deadline, url, status, appliedDate, memo, history)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      job.id,
      job.company,
      job.title,
      job.region,
      job.deadline,
      job.url || "",
      job.status || "관심",
      job.appliedDate || "",
      job.memo || "",
      historyJson
    ).run();

    return new Response(JSON.stringify({ success: true, job }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

// 3. 공고 삭제 (DELETE)
export async function onRequestDelete(context) {
  try {
    const url = new URL(context.request.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response(JSON.stringify({ error: "Missing id parameter" }), { status: 400 });
    }

    await context.env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(id).run();

    return new Response(JSON.stringify({ success: true, deletedId: id }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
