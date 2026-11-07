require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const { HttpError, objectId, pagination, escapeRegex, searchTerm, dateFilter, doctorFields, patientFields } = require('./src/utils');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const client = process.env.MONGODB_URI ? new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 }) : null;
let dbPromise;
async function getDb() {
  if (!client) throw new Error('MONGODB_URI is missing');
  if (!dbPromise) {
    dbPromise = (async () => {
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || 'doctor-tracker');
      const doctors = db.collection('doctors');
      const patients = db.collection('patients');
      const users = db.collection('user');
      // Index builds are scheduled separately so a temporary index issue does not break stats.
      Promise.all([
        doctors.createIndexes([
          { key: { searchName: 1, _id: 1 }, name: 'doctor_name' },
          { key: { searchHospital: 1, _id: 1 }, name: 'doctor_hospital' },
          { key: { specialty: 1, createdAt: -1 }, name: 'doctor_specialty_date' },
          { key: { createdAt: -1 }, name: 'doctor_created' }
        ]),
        patients.createIndexes([
          { key: { searchName: 1 }, name: 'patient_name' },
          { key: { doctorId: 1, createdAt: -1 }, name: 'patient_doctor_date' },
          { key: { condition: 1, createdAt: -1 }, name: 'patient_condition_date' },
          { key: { createdAt: -1 }, name: 'patient_created' }
        ])
      ]).catch(error => console.error('MongoDB index creation warning:', error.codeName || error.name || 'unknown'));
      return { db, doctors, patients, users };
    })().catch((error) => { dbPromise = null; throw error; });
  }
  return dbPromise;
}
const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
// Test seam: API integration tests provide in-memory collection implementations.
app.locals.getDb = getDb;

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

// All Express requests independently verify the Better Auth cookie against
// Next.js. This works with the existing PORT/MONGODB_URI-only server .env.
app.get('/', (_req, res) => res.status(200).json({
  name: 'Doctors Tracker REST API',
  message: 'Welcome to Doctors Tracker — a secure Express.js and MongoDB service.',
  version: '1.2.0',
  status: 'running',
  documentation: 'https://github.com/mr-mizanur/Doctors-Tracker-Server',
  routes: {
    public: ['GET /', 'GET /health', 'GET /health/db'],
    protected: ['GET /api/stats', 'GET /api/doctors', 'POST /api/doctors',
      'GET /api/doctors/:id', 'PUT /api/doctors/:id', 'DELETE /api/doctors/:id',
      'GET /api/patients', 'POST /api/patients',
      'PUT /api/patients/:id', 'DELETE /api/patients/:id']
  },
  security: 'Protected APIs require an authenticated administrator (MongoDB user.role=admin).'
}));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'doctors-tracker-api' }));
// Standalone MongoDB readiness check: safe status only, never outputs credentials.
app.get('/health/db', asyncHandler(async (_req, res) => {
  try {
    const { db } = await app.locals.getDb();
    await db.command({ ping: 1 });
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('MongoDB health check failed:', error.codeName || error.message);
    res.status(503).json({ status: 'unavailable', database: 'disconnected', help: 'Check MONGODB_URI, MongoDB Atlas Network Access IP allowlist, database user permissions, and server logs.' });
  }
}));
app.use('/api', asyncHandler(async (req, res, next) => {
  const cookie = req.get('cookie');
  if (!cookie) return res.status(401).json({ error: 'Please sign in to continue' });

  let sessionResponse;
  try {
    sessionResponse = await fetch(FRONTEND_URL + '/api/auth/get-session', {
      method: 'GET',
      headers: { Cookie: cookie, Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8000)
    });
  } catch (error) {
    console.error('Auth service is unavailable:', error.message);
    return res.status(503).json({ error: 'Authentication service is unavailable. Start the frontend application.' });
  }
  if (!sessionResponse.ok) return res.status(401).json({ error: 'Session verification failed' });
  let session;
  try { session = await sessionResponse.json(); }
  catch { return res.status(502).json({ error: 'Authentication service returned an invalid response' }); }
  if (!session?.session?.id || !session?.user?.email)
    return res.status(401).json({ error: 'Please sign in again' });
  req.authUser = session.user;
  next();
}));
app.use('/api', asyncHandler(async (req, res, next) => {
  const collections = await app.locals.getDb();
  // NEVER trust a role claim from a session cookie; MongoDB 'user' is authoritative.
  // This immediately reflects an administrator promoting/revoking an account in Atlas.
  const email = req.authUser?.email?.toLowerCase();
  if (!email || typeof email !== 'string') return res.status(401).json({ error: 'Invalid user session' });
  const dbUser = await collections.users.findOne(
    { email },
    { projection: { role: 1, email: 1 } }
  );
  if (!dbUser || dbUser.role !== 'admin')
    return res.status(403).json({ error: 'Administrator role required. Please contact the administrator.' });

  req.collections = collections;
  next();
}));

const buildList = async (collection, filter, req, sort = { createdAt: -1, _id: -1 }) => {
  const { page, limit, skip } = pagination(req.query);
  const [items, total] = await Promise.all([
    collection.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
    collection.countDocuments(filter)
  ]);
  return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

app.get('/api/doctors', asyncHandler(async (req,res) => {
  const { doctors, patients } = req.collections;
  const filter = {};
  const search = searchTerm(req.query.search);
  if (search) {
    const pattern = new RegExp('^' + escapeRegex(search));
    filter.$or = [{searchName: pattern}, {searchHospital: pattern}];
  }
  if (req.query.specialty && req.query.specialty !== 'All') filter.specialty = req.query.specialty;
  if (req.query.hospital) filter.searchHospital = new RegExp('^' + escapeRegex(searchTerm(req.query.hospital)));
  const dates = dateFilter(req.query);
  if (dates) filter.createdAt = dates;
  const data = await buildList(doctors, filter, req);
  const ids = data.items.map((d) => d._id);
  if (ids.length) {
    const counts = await patients.aggregate([
      { $match: { doctorId: { $in: ids } } },
      { $group: { _id: '$doctorId', count: { $sum: 1 } } }
    ]).toArray();
    const countMap = new Map(counts.map((x) => [String(x._id), x.count]));
    data.items = data.items.map((d) => ({...d, patientCount: countMap.get(String(d._id)) || 0}));
  }
  res.json(data);
}));
app.post('/api/doctors', asyncHandler(async (req,res) => {
  const doc = {...doctorFields(req.body), createdAt: new Date(), updatedAt: new Date()};
  const result = await req.collections.doctors.insertOne(doc);
  res.status(201).json({ ...doc, _id: result.insertedId });
}));
app.get('/api/doctors/:id', asyncHandler(async (req,res) => {
  const id = objectId(req.params.id);
  const doctor = await req.collections.doctors.findOne({_id:id});
  if (!doctor) throw new HttpError(404, 'Doctor not found');
  const patientCount = await req.collections.patients.countDocuments({doctorId:id});
  res.json({...doctor, patientCount});
}));
app.put('/api/doctors/:id', asyncHandler(async (req,res) => {
  const id = objectId(req.params.id);
  const changes = {...doctorFields(req.body), updatedAt: new Date()};
  const result = await req.collections.doctors.findOneAndUpdate({_id:id}, {$set: changes}, {returnDocument:'after'});
  if (!result) throw new HttpError(404, 'Doctor not found');
  res.json(result);
}));
app.delete('/api/doctors/:id', asyncHandler(async (req,res) => {
  const id = objectId(req.params.id);
  const count = await req.collections.patients.countDocuments({doctorId:id});
  if (count) throw new HttpError(409, 'Remove or reassign this doctor’s patients before deleting the doctor');
  const result = await req.collections.doctors.deleteOne({_id:id});
  if (!result.deletedCount) throw new HttpError(404, 'Doctor not found');
  res.json({success:true});
}));

app.get('/api/patients', asyncHandler(async (req,res) => {
  const filter = {};
  if (req.query.doctorId) filter.doctorId = objectId(req.query.doctorId);
  const search = searchTerm(req.query.search);
  if (search) filter.searchName = new RegExp('^' + escapeRegex(search));
  if (req.query.condition && req.query.condition !== 'All') filter.condition = req.query.condition;
  const dates = dateFilter(req.query);
  if (dates) filter.createdAt = dates;
  const data = await buildList(req.collections.patients, filter, req);
  const ids = [...new Map(data.items.filter(x=>x.doctorId).map(x=>[String(x.doctorId),x.doctorId])).values()];
  const doctors = ids.length ? await req.collections.doctors.find({_id:{$in: ids}}).project({name:1,specialty:1}).toArray() : [];
  const doctorMap = new Map(doctors.map(d=>[String(d._id),d]));
  data.items = data.items.map(p=>({...p, doctor: doctorMap.get(String(p.doctorId)) || null}));
  res.json(data);
}));
app.post('/api/patients', asyncHandler(async (req,res) => {
  const patient = {...patientFields(req.body), createdAt:new Date(), updatedAt:new Date()};
  const doctor = await req.collections.doctors.findOne({_id: patient.doctorId}, {projection:{_id:1}});
  if (!doctor) throw new HttpError(404, 'Doctor not found');
  const result = await req.collections.patients.insertOne(patient);
  res.status(201).json({...patient, _id:result.insertedId});
}));
app.put('/api/patients/:id', asyncHandler(async (req,res) => {
  const id = objectId(req.params.id);
  const changes = {...patientFields(req.body), updatedAt:new Date()};
  const doctor = await req.collections.doctors.findOne({_id: changes.doctorId}, {projection:{_id:1}});
  if (!doctor) throw new HttpError(404, 'Doctor not found');
  const result = await req.collections.patients.findOneAndUpdate({_id:id}, {$set:changes}, {returnDocument:'after'});
  if (!result) throw new HttpError(404, 'Patient not found');
  res.json(result);
}));
app.delete('/api/patients/:id', asyncHandler(async (req,res) => {
  const result = await req.collections.patients.deleteOne({_id:objectId(req.params.id)});
  if (!result.deletedCount) throw new HttpError(404, 'Patient not found');
  res.json({success:true});
}));
// Counters must continue working even if a legacy record breaks optional chart aggregation.
app.get('/api/stats', asyncHandler(async (req,res) => {
  const {doctors, patients} = req.collections;
  const [totalDoctors, totalPatients, unassignedPatients] = await Promise.all([
    doctors.countDocuments({}),
    patients.countDocuments({}),
    patients.countDocuments({$or: [{doctorId: {$exists: false}}, {doctorId: null}]})
  ]);
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 13));
  const [countsResult, historyResult] = await Promise.allSettled([
    patients.aggregate([
      {$match:{doctorId:{$type:'objectId'}}},
      {$group:{_id:'$doctorId', count:{$sum:1}}},
      {$sort:{count:-1}}, {$limit:8},
      {$lookup:{from:'doctors',localField:'_id',foreignField:'_id',as:'doctor'}},
      {$unwind:'$doctor'},
      {$project:{_id:0, doctorId:'$_id', name:'$doctor.name', count:1}}
    ]).toArray(),
    patients.aggregate([
      // Legacy records may contain an ISO string or an invalid createdAt value.
      {$set:{parsedCreatedAt:{$convert:{input:'$createdAt',to:'date',onError:null,onNull:null}}}},
      {$match:{parsedCreatedAt:{$gte:start}}},
      {$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$parsedCreatedAt',timezone:'UTC'}}, count:{$sum:1}}},
      {$sort:{_id:1}}
    ]).toArray()
  ]);
  const warnings = [];
  if (countsResult.status === 'rejected') {
    console.error('Stats patients-per-doctor aggregation failed:', countsResult.reason?.message || countsResult.reason);
    warnings.push('Doctor workload chart is temporarily unavailable');
  }
  if (historyResult.status === 'rejected') {
    console.error('Stats daily aggregation failed:', historyResult.reason?.message || historyResult.reason);
    warnings.push('Daily patient chart is temporarily unavailable');
  }
  const counts = countsResult.status === 'fulfilled' ? countsResult.value : [];
  const history = historyResult.status === 'fulfilled' ? historyResult.value : [];
  const dailyMap = new Map(history.map(x=>[x._id,x.count]));
  const dailyPatients = Array.from({length:14},(_,i)=>{
    const date = new Date(start.getTime()+i*86400000).toISOString().slice(0,10);
    return {date,count:dailyMap.get(date)||0};
  });
  res.json({totalDoctors,totalPatients,unassignedPatients,patientsPerDoctor:counts,dailyPatients,analyticsWarnings:warnings});
}));
app.use('/api', (_req,res)=>res.status(404).json({error:'API route not found'}));
app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({error:'Invalid JSON'});
  if (err instanceof HttpError) return res.status(err.status).json({error:err.message});
  if (err?.status === 413) return res.status(413).json({error:'Request too large'});
  console.error('API failure:', err?.name || 'Error', err?.codeName || err?.code || '', err?.message || '');
  if (!client || err?.name?.includes('Mongo') || err?.name === 'MongoNetworkTimeoutError' || err?.codeName || err?.code === 'ECONNREFUSED')
    return res.status(503).json({error:'MongoDB unavailable. Verify .env, MongoDB Atlas IP allowlist, database credentials and permissions. See server terminal logs.'});
  res.status(500).json({error:'Internal server error. Inspect the Express server terminal for the underlying cause.'});
});
if (require.main === module && !process.env.VERCEL) {
  const port = Number(process.env.PORT || 5000);
  app.listen(port,()=>console.log('Doctors Tracker API listening on port ' + port));
}
module.exports = app;
