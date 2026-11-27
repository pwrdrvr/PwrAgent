export const OWNER_JOB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS owner_jobs (
    job_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL CHECK(json_valid(payload))
  );
  CREATE INDEX IF NOT EXISTS owner_jobs_by_thread_created ON owner_jobs (
    json_extract(payload, '$.threadId'), coalesce(json_extract(payload, '$.createdAt'), '') DESC, job_id
  ) WHERE json_extract(payload, '$.threadId') IS NOT NULL;
`;
