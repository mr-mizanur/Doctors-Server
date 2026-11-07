const test = require('node:test');
const assert = require('node:assert/strict');
const { pagination, dateFilter, doctorFields, patientFields, escapeRegex } = require('../src/utils');
test('pagination boundaries', () => {
  assert.deepEqual(pagination({page:'2',limit:'5'}), {page:2,limit:5,skip:5});
  assert.throws(()=>pagination({limit:'1000'}));
  assert.throws(()=>pagination({page:'-1'}));
});
test('date filtering uses UTC inclusive day bounds', () => {
  const result=dateFilter({dateFrom:'2026-11-01',dateTo:'2026-11-02'});
  assert.equal(result.$gte.toISOString(),'2026-11-01T00:00:00.000Z');
  assert.equal(result.$lt.toISOString(),'2026-11-03T00:00:00.000Z');
  assert.throws(()=>dateFilter({dateFrom:'2026-02-30'}));
});
test('doctor input sanitizes and restricts fields',()=>{
  const d=doctorFields({name:' Dr. Doe ', specialty:'GP', hospital:'City', phone:'+8801712345678', email:'DR@EXAMPLE.COM',isAdmin:true});
  assert.equal(d.searchName,'dr. doe');
  assert.equal(d.email,'dr@example.com');
  assert.equal(d.isAdmin,undefined);
});
test('patient requires valid doctor and age',()=>{
  assert.throws(()=>patientFields({name:'A',age:121,condition:'Test',doctorId:'bad'}));
  assert.equal(patientFields({name:'A',age:25,condition:'Test',doctorId:'507f1f77bcf86cd799439011'}).age,25);
});
test('escapeRegex neutralizes regex operators',()=>{
  assert.equal(escapeRegex('a.*(b)'), 'a\\.\\*\\(b\\)');
});
