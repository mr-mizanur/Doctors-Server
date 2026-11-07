const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

let db, doctorsCollection, patientsCollection;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db("doctor-tracker");
    doctorsCollection = db.collection("doctors");
    patientsCollection = db.collection("patients");
    console.log("Connected to MongoDB successfully!");
  }
}

// Middleware to ensure DB connection on Vercel serverless environment
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error("DB connection error:", error);
    res.status(500).json({ error: "Database connection failed" });
  }
});

// --- Dashboard Stats ---
app.get('/api/stats', async (req, res) => {
  try {
    const totalDoctors = await doctorsCollection.countDocuments();
    const totalPatients = await patientsCollection.countDocuments();
    res.json({ totalDoctors, totalPatients });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// --- Doctors APIs (with Search, Filter & Pagination) ---
app.get('/api/doctors', async (req, res) => {
  try {
    const { search, specialty, page = 1, limit = 10 } = req.query;
    let query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { hospital: { $regex: search, $options: 'i' } }
      ];
    }

    if (specialty && specialty !== 'All') {
      query.specialty = specialty;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const doctors = await doctorsCollection.find(query).skip(skip).limit(parseInt(limit)).toArray();
    const total = await doctorsCollection.countDocuments(query);

    res.json({ doctors, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch doctors" });
  }
});

app.post('/api/doctors', async (req, res) => {
  try {
    const result = await doctorsCollection.insertOne({ ...req.body, createdAt: new Date() });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to add doctor" });
  }
});

app.delete('/api/doctors/:id', async (req, res) => {
  try {
    const result = await doctorsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to delete doctor" });
  }
});

// --- Patients APIs (with Search, Filter & Pagination) ---
app.get('/api/patients', async (req, res) => {
  try {
    const { search, condition, page = 1, limit = 10 } = req.query;
    let query = {};

    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    if (condition && condition !== 'All') {
      query.condition = condition;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const patients = await patientsCollection.find(query).skip(skip).limit(parseInt(limit)).toArray();
    const total = await patientsCollection.countDocuments(query);

    res.json({ patients, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch patients" });
  }
});

app.post('/api/patients', async (req, res) => {
  try {
    const result = await patientsCollection.insertOne({ ...req.body, createdAt: new Date() });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to add patient" });
  }
});

app.put('/api/patients/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const updatedData = req.body;
    const result = await patientsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updatedData }
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to update patient" });
  }
});

app.delete('/api/patients/:id', async (req, res) => {
  try {
    const result = await patientsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Failed to delete patient" });
  }
});

// Root Endpoint
app.get('/', (req, res) => {
  res.send('Doctor Tracker Express Server is running on Vercel...');
});

// For local testing
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running locally on port ${PORT}`);
  });
}

module.exports = app;