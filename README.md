# Doctor Tracker Server

##Project Overview
Doctor Tracker Server is a standalone Node.js and Express.js RESTful API designed to power the Doctor Tracker administrative application. It handles secure database operations, Doctor & Patient CRUD workflows, search filters, pagination, and real-time dashboard analytics via MongoDB.

---

## Tech Stack & Dependencies

- **Runtime Environment:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB (Native MongoDB Driver)
- **Middleware & Utilities:** CORS, Dotenv, Express JSON

---

## Core API Endpoints
- **Stats:** GET `/api/stats` (Fetches total counts for doctors and patients)
- **Doctors:** 
  - GET `/api/doctors` (List doctors with search, specialty filter, and pagination)
  - POST `/api/doctors` (Create a new doctor)
  - DELETE `/api/doctors/:id` (Delete a doctor)
- **Patients:** 
  - GET `/api/patients` (List patients with search, condition filter, and pagination)
  - POST `/api/patients` (Create a new patient)
  - PUT `/api/patients/:id` (Update patient info)
  - DELETE `/api/patients/:id` (Delete a patient)