# Doctors Tracker — REST API

Secure standalone Express 5 / MongoDB service for [Doctors Tracker](https://github.com/mr-mizanur/Doctors-Tracker). All /api routes require the secret server-to-server `x-internal-key` header. Do **not** call this API directly from the browser; Next.js validates Better Auth sessions and forwards authorized admin requests through its server-only gateway.

## Setup

1. Install Node.js 20+ and MongoDB Atlas (or local MongoDB).
2. Run `npm ci` (or `npm install` if regenerating the lockfile).
3. Copy `.env.example` to `.env` and set `MONGODB_URI`, `MONGODB_DB`, and `INTERNAL_API_KEY` (at least 32 random characters).
4. Run `npm run dev`. Test `GET http://localhost:5000/health`.
5. Run `npm test` for input-validation tests.
6. Set `NEXT_PUBLIC_API_URL`? **No**: configure the frontend's server-only `BACKEND_URL=http://localhost:5000` and `BACKEND_API_KEY` to the same value as `INTERNAL_API_KEY`.

## Architecture

Browser → Better Auth session (Next.js) → /api/backend/* (Next.js server verifies admin allowlist) → x-internal-key → Express → MongoDB collections doctors/patients. The API key is never made public. Deploying the two apps to different origins is supported because all browser calls stay on the Next.js origin.

## Endpoints

Public: `GET /health`. Authenticated internal API:
- `GET, POST /api/doctors`; `GET, PUT, DELETE /api/doctors/:id`
- `GET, POST /api/patients`; `PUT, DELETE /api/patients/:id`
- `GET /api/stats`

List query parameters: `page` (>=1), `limit` (1–50), `search` (case-insensitive **prefix**), `dateFrom`/`dateTo` (YYYY-MM-DD UTC). Doctors: `specialty`, `hospital`; patients: `condition`, `doctorId`. Responses return `{items,pagination:{page,limit,total,pages}}`. Patients must reference an existing doctor. Doctor deletion is blocked (409) when patients still reference that doctor.

## Technical decisions

1. **Gateway + shared service secret:** Keeping Better Auth in Next.js avoids sending browser cookies to a different-origin Express service. Each data route checks the user session and admin email allowlist before forwarding with a server-only 32+-character key. The Express service rejects requests without that key. Rotate both secrets together.
2. **Indexed normalized prefix search and server pagination:** Doctors store `searchName`/`searchHospital` and patients store `searchName` for escaped anchored regex, which can use B-tree prefix indexes. Filtering and pagination run in MongoDB with stable date/_id sorting; counts and chart series use aggregation instead of fetching every patient record. These are prefix searches rather than arbitrary substring matching.

## Existing-data note

Records created with the previous server do not have normalized search fields or doctorId. Existing records remain visible in unfiltered lists; those records will not match indexed search until migrated. Old patients remain unassigned until associated with a doctor. Back up your database before migrations.

## Security

Set a long, random `INTERNAL_API_KEY`; restrict the API deployment at the network edge when possible. Do not store real patient health records unless you have appropriate consent, access controls, retention and compliance procedures. The application is a project demonstration, not a production clinical record system.
