const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'controllers/student.controller.js');
let code = fs.readFileSync(filePath, 'utf8');

// Replacements

// 1. Add club to addStudent req.body destructuring
code = code.replace(
  'admissionDate, dateOfBirth, orphan, religion, bloodGroup, genotype,\n        address, previousSchool, parentProfileId, sessionId, subjectCategoryId, profilePicture',
  'admissionDate, dateOfBirth, orphan, religion, club, bloodGroup, genotype,\n        address, previousSchool, parentProfileId, sessionId, subjectCategoryId, profilePicture'
);

// 2. Add club to studentProfile.create in addStudent
code = code.replace(
  'orphan: orphan === true || orphan === \'yes\',\n                        religion: religion || null,\n                        bloodGroup: bloodGroup || null,\n                        genotype: genotype || null,',
  'orphan: orphan === true || orphan === \'yes\',\n                        religion: religion || null,\n                        club: club || null,\n                        bloodGroup: bloodGroup || null,\n                        genotype: genotype || null,'
);

// 3. Add club to updateStudent req.body destructuring
code = code.replace(
  'admissionDate, dateOfBirth, orphan, religion, bloodGroup, genotype,\n        address, previousSchool, parentProfileId, sessionId, subjectCategoryId\n    } = req.body',
  'admissionDate, dateOfBirth, orphan, religion, club, bloodGroup, genotype,\n        address, previousSchool, parentProfileId, sessionId, subjectCategoryId\n    } = req.body'
);

// 4. Add club to updateStudent updateData check
code = code.replace(
  'if (Object.keys(updateData).length > 0 || classLevel || classId || gender || status || phone || dateOfBirth || orphan !== undefined || religion || bloodGroup || address || previousSchool || parentProfileId || subjectCategoryId !== undefined) {',
  'if (Object.keys(updateData).length > 0 || classLevel || classId || gender || status || phone || dateOfBirth || orphan !== undefined || religion || club !== undefined || bloodGroup || address || previousSchool || parentProfileId || subjectCategoryId !== undefined) {'
);

// 5. Add club to studentProfile.update in updateStudent
code = code.replace(
  'orphan: orphan === \'yes\',\n                religion,\n                bloodGroup,\n                genotype,',
  'orphan: orphan === \'yes\',\n                religion,\n                club,\n                bloodGroup,\n                genotype,'
);

fs.writeFileSync(filePath, code);
console.log('Patch complete.');
