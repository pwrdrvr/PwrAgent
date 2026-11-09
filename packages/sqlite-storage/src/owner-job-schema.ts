export const OWNER_JOB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS owner_jobs (
    job_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL CHECK(json_valid(payload))
  );
`;
