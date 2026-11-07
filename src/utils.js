const { ObjectId } = require('mongodb');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (message) => { throw new HttpError(400, message); };
const cleanText = (value, label, max = 120, optional = false) => {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string') return fail(label + ' must be text');
  const result = value.trim().replace(/\s+/g, ' ');
  if (!result || result.length > max) return fail(label + ' must be 1–' + max + ' characters');
  return result;
};
const objectId = (id) => {
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id)) throw new HttpError(400, 'Invalid record ID');
  return new ObjectId(id);
};
const pagination = (query = {}) => {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? 10);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new HttpError(400, 'page must be 1–100000 and limit must be 1–50');
  return { page, limit, skip: (page - 1) * limit };
};
const escapeRegex = (value) => value.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
const searchTerm = (value) => {
  if (value === undefined || value === '') return '';
  return cleanText(value, 'Search', 80).toLowerCase();
};
const dateFilter = ({ dateFrom, dateTo }) => {
  const parse = (input, label) => {
    if (!input) return null;
    if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) throw new HttpError(400, label + ' must use YYYY-MM-DD');
    const d = new Date(input + 'T00:00:00.000Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0,10) !== input) throw new HttpError(400, 'Invalid ' + label);
    return d;
  };
  const from = parse(dateFrom, 'dateFrom');
  const to = parse(dateTo, 'dateTo');
  if (from && to && from > to) throw new HttpError(400, 'dateFrom cannot be after dateTo');
  const result = {};
  if (from) result.$gte = from;
  if (to) result.$lt = new Date(to.getTime() + 86400000);
  return Object.keys(result).length ? result : null;
};
const doctorFields = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Invalid doctor payload');
  const name = cleanText(input.name, 'Name', 120);
  const specialty = cleanText(input.specialty, 'Specialization', 100);
  const hospital = cleanText(input.hospital, 'Hospital', 150);
  const phone = cleanText(input.phone, 'Phone', 30, true);
  const email = cleanText(input.email, 'Email', 160, true).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Invalid email address');
  if (phone && !/^[+\d\s()\-]{7,30}$/.test(phone)) return fail('Invalid phone number');
  return { name, specialty, hospital, phone, email, searchName: name.toLowerCase(), searchHospital: hospital.toLowerCase() };
};
const patientFields = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Invalid patient payload');
  const name = cleanText(input.name, 'Patient name', 120);
  const age = Number(input.age);
  if (input.age === '' || input.age === undefined || !Number.isInteger(age) || age < 0 || age > 120)
    return fail('Age must be an integer between 0 and 120');
  const condition = cleanText(input.condition, 'Condition', 120);
  const doctorId = objectId(input.doctorId);
  return { name, age, condition, doctorId, searchName: name.toLowerCase() };
};
module.exports = { HttpError, objectId, pagination, escapeRegex, searchTerm, dateFilter, doctorFields, patientFields };
