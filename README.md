# Doctors Tracker — Express API

This secure standalone Express + MongoDB service powers the [Next.js Doctors Tracker frontend](https://github.com/mr-mizanur/Doctors-Tracker). Manage doctors and their associated patients, search/filter/paginate, and retrieve aggregated dashboard analytics.

## Local setup

1. Install Node.js 20+ and configure a MongoDB Atlas database.
2. Run `npm install`.
3. Copy `.env.example` to `.env`. Set `MONGODB_URI` and `PORT=5000`. The frontend URL defaults to `http://localhost:3000`.
4. Run `npm run dev` or `npm start`; `GET http://localhost:5000/health` should return status `ok`.
5. In another terminal, run the frontend with its own `.env.local`.
6. Run `npm test` for input validation tests.

## Environment

```dotenv
PORT=5000
MONGODB_URI=mongodb+srv://<db-user>:<db-password>@<cluster>.mongodb.net/doctor-tracker?retryWrites=true&w=majority
MONGODB_DB=doctor-tracker
FRONTEND_URL=http://localhost:3000
```

Never commit the real MongoDB connection string or Better Auth credentials.

## Role-based authentication

- Registered accounts default to `role: "user"` (not an admin).
- Both the Next.js dashboard gateway and Express require `role === "admin"`.
- A signed-in non-admin receives HTTP `403` on every `/api/*` route. MongoDB is the source of truth for roles.
- Promote one account via the `doctor-tracker` database, Better Auth `user` collection: `db.user.updateOne({email:"someone@example.com"}, {$set:{role:"admin"}})`.
- Once promoted, the user can refresh their `/pending` page to check access; signing out and back in also refreshes session state.
- Never create a public endpoint where users can set their own roles.

## Security and architecture

Browser → Next.js (Better Auth login) → Next.js same-origin API proxy → Express REST API → MongoDB.

**Every** Express `/api` call verifies the forwarded Better Auth session cookie by requesting the frontend `/api/auth/get-session` endpoint. It does not trust an unsanitized browser-supplied user identifier and denies requests without a valid session. Express independently looks up the authenticated user's **current** role in the MongoDB `user` collection for **every** REST request. `session.user.role` is not trusted for authorization; role promotions and demotions take effect immediately after the next request. New registrations receive the server-owned `user` role; a database administrator must explicitly promote the account to `admin` in the Better Auth `user` collection. The client cannot set or change this field. The cookie is sent only to the configured frontend auth service; never log cookies.

The two apps must be running together; a backend request made before the frontend is available will return a 503 authentication-service error. For production, change `FRONTEND_URL` to the deployed frontend's HTTPS origin and `BACKEND_URL` in the frontend to the server's HTTPS origin. Use HTTPS, trusted deployment configuration, and least-privilege DB access.

## REST endpoints

All endpoints except `/health` require a valid session.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/doctors` | List doctors |
| POST | `/api/doctors` | Create doctor |
| GET | `/api/doctors/:id` | Doctor detail and patient count |
| PUT | `/api/doctors/:id` | Edit doctor |
| DELETE | `/api/doctors/:id` | Delete only when no associated patients |
| GET | `/api/patients` | List patients |
| POST | `/api/patients` | Add patient under a doctor |
| PUT | `/api/patients/:id` | Edit patient |
| DELETE | `/api/patients/:id` | Delete patient |
| GET | `/api/stats` | Totals, daily trend and patients per doctor |

List query parameters: `search` (case-insensitive **prefix**), `dateFrom`, `dateTo` (`YYYY-MM-DD`, UTC), `page` (>=1), `limit` (1–50). Doctors support `specialty` and `hospital`. Patients support `condition` and `doctorId`. Lists return `{items,pagination:{page,limit,total,pages}}`.

## Database design and technical decisions

- **Independent auth verification** rather than a shared static API secret: the existing two-process setup can run with the supplied backend environment. The backend checks each user session through Better Auth before executing database operations; Express never accepts anonymous CRUD.
- **Server-side filtering and indexing:** normalized searchable fields plus escaped anchored regex enable B-tree prefix lookup. Compound indexes optimize date, condition and doctor joins. Pagination and analytics use database queries/aggregation rather than loading all rows into React. Top-doctor counts are joined in MongoDB.

Legacy data from the previous server can lack `searchName` and `doctorId`; back it up and migrate these fields before relying on search or doctor-linked analytics. Protect patient information; this demo is not a clinical-record compliance solution.

## Troubleshooting `/api/stats`

- Open `http://localhost:5000/health` to see if Express is running.
- Open `http://localhost:5000/health/db` to test MongoDB connectivity (this reports only connection status, not database contents).
- A direct browser request to `/api/stats` **requires** a signed-in Better Auth session; otherwise 401 is expected. Use the Next.js dashboard or `http://localhost:3000/api/backend/stats` while signed in.
- For 503 errors: check `MONGODB_URI` in the server's local `.env`, MongoDB Atlas Network Access allowed IPs, and the Atlas database user/password. Read the Express terminal for the actual error.
- For index creation errors, the server now logs a warning and still performs the database queries; data analytics do not depend on indexes being built synchronously.
- Dashboard daily analytics now handles old records with dates stored as ISO strings; one chart failure no longer blocks total counts.
