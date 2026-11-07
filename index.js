require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const { timingSafeEqual } = require('crypto');
const { HttpError, objectId, pagination, escapeRegex, searchTerm, dateFilter, doctorFields, patientFields } = require('./src/utils');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const client = process.env.MONGODB_URI ? new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10 }) : null;
let dbPromise;
async function getDb() {
  if (!client) throw new Error('MONGODB_URI is missing');
  if (!dbPromise) {
    dbPromise = (async () => {
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || 'doctor-tracker');
      const doctors = db.collection('doctors');
      const patients = db.collection('patients');
      await Promise.all([
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
      ]);
      return { doctors, patients };
    })().catch((error) => { dbPromise = null; throw error; });
  }
  return dbPromise;
}
const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
const validKey = (supplied, expected) => {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || expected.length < 32) return false;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a,b);
};

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'doctors-tracker-api' }));
app.use('/api', (req, res, next) => {
  if (!validKey(req.get('x-internal-key'), process.env.INTERNAL_API_KEY))
    return res.status(401).json({ error: 'Unauthorized' });
  next();
});
app.use('/api', asyncHandler(async (req, _res, next) => {
  req.collections = await getDb();
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
app.get('/api/stats', asyncHandler(async (req,res) => {
  const {doctors,patients} = req.collections;
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 13));
  const [totalDoctors,totalPatients,unassignedPatients,counts,history] = await Promise.all([
    doctors.countDocuments(), patients.countDocuments(),
    patients.countDocuments({$or:[{doctorId:{$exists:false}},{doctorId:null}]}),
    patients.aggregate([
      {$match:{doctorId:{$type:'objectId'}}},
      {$group:{_id:'$doctorId',count:{$sum:1}}},
      {$sort:{count:-1}},
      {$limit:8},
      {$lookup:{from:'doctors',localField:'_id',foreignField:'_id',as:'doctor'}},
      {$unwind:'$doctor'},
      {$project:{_id:0,doctorId:'$_id',name:'$doctor.name',count:1}}
    ]).toArray(),
    patients.aggregate([
      {$match:{createdAt:{$gte:start}}},
      {$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$createdAt',timezone:'UTC'}},count:{$sum:1}}},
      {$sort:{_id:1}}
    ]).toArray()
  ]);
  const dailyMap = new Map(history.map(x=>[x._id,x.count]));
  const dailyPatients = Array.from({length:14},(_,i)=>{
    const date = new Date(start.getTime() + i*86400000).toISOString().slice(0,10);
    return {date,count:dailyMap.get(date)||0};
  });
  res.json({totalDoctors,totalPatients,unassignedPatients,patientsPerDoctor:counts,dailyPatients});
}));
app.use('/api', (_req,res)=>res.status(404).json({error:'API route not found'}));
app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({error:'Invalid JSON'});
  if (err instanceof HttpError) return res.status(err.status).json({error:err.message});
  if (err?.status === 413) return res.status(413).json({error:'Request too large'});
  console.error('API failure:', err?.message || err);
  res.status(500).json({error:'Internal server error'});
});
if (require.main === module && !process.env.VERCEL) {
  const port = Number(process.env.PORT || 5000);
  app.listen(port,()=>console.log('Doctors Tracker API listening on port ' + port));
}
module.exports = app;
