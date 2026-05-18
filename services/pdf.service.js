const puppeteer = require('puppeteer');

const template1 = (data) => {
  const school = data.school || { name: "EXEMPLAR INTERNATIONAL SCHOOL", motto: "Knowledge and Integrity", address: "123 Education Lane, Lagos", phone: "+234 800 000 0000" };
  const student = data.student || { name: "JOHN DOE", admissionNo: "ADM/2025/001", class: "JSS 1 Gold", noInClass: 30 };
  const result = data.result || { term: "2ND TERM", academicYear: "2023/2024", position: "1st", scores: [], affectiveTraits: [], psychomotorTraits: [] };

  const getRemarkColor = (remark) => {
    switch (remark.toLowerCase()) {
      case 'excellent': return 'bg-green-800 text-white';
      case 'v. good': return 'bg-blue-600 text-white';
      case 'good': return 'bg-green-500 text-white';
      case 'fair': return 'bg-yellow-500 text-black';
      case 'weak': return 'bg-pink-500 text-white';
      default: return 'bg-gray-500 text-white';
    }
  };

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
          body { font-family: 'Inter', sans-serif; }
        </style>
      </head>
      <body class="bg-white p-8 max-w-4xl mx-auto border border-gray-300 text-sm">
        <div class="flex justify-between items-center mb-4">
          <div class="w-20 h-20 bg-gray-200 flex items-center justify-center text-xs text-gray-500">Logo</div>
          <div class="text-center flex-1 mx-4">
            <h1 class="text-2xl font-bold text-gray-900">${school.name}</h1>
            <p class="text-sm italic text-gray-600">${school.motto}</p>
            <p class="text-xs text-gray-600">${school.address}</p>
            <p class="text-xs text-gray-600">Phone: ${school.phone}</p>
          </div>
          <div class="w-20 h-20"></div>
        </div>

        <div class="bg-[#0a192f] text-white text-center py-2 font-bold mb-4">
          ${result.term} EXAM REPORT SHEET ${result.academicYear} SESSION
        </div>

        <div class="text-center mb-4">
          <h2 class="text-xl font-bold text-gray-900">${student.name}</h2>
        </div>

        <div class="grid grid-cols-4 gap-y-2 text-xs border border-gray-300 p-4 mb-4">
          <div><span class="font-bold">Admission No:</span> ${student.admissionNo}</div>
          <div><span class="font-bold">Class:</span> ${student.class}</div>
          <div><span class="font-bold">No. in Class:</span> ${student.noInClass}</div>
          <div><span class="font-bold">Term End Date:</span> ${result.termEndDate || '—'}</div>
          
          <div><span class="font-bold">Days Opened:</span> ${result.daysOpened || '—'}</div>
          <div><span class="font-bold">Present:</span> ${result.present || '—'}</div>
          <div><span class="font-bold">Absent:</span> ${result.absent || '—'}</div>
          <div><span class="font-bold">Next Term Begins:</span> ${result.nextTermBegins || '—'}</div>
          
          <div><span class="font-bold">Final Average:</span> ${result.finalAverage || '—'}</div>
          <div><span class="font-bold">Highest Average:</span> ${result.highestAverage || '—'}</div>
          <div><span class="font-bold">Lowest Average:</span> ${result.lowestAverage || '—'}</div>
          <div class="bg-yellow-100 p-1"><span class="font-bold">Class Average:</span> ${result.classAverage || '—'}</div>
          
          <div><span class="font-bold">Final Grade:</span> ${result.finalGrade || '—'}</div>
          <div><span class="font-bold">Next Term Fees:</span> ${result.nextTermFees || '—'}</div>
        </div>

        <div class="text-center font-bold text-lg mb-4">
          Position: ${result.position}
        </div>

        <div class="flex gap-4 mb-4">
          <div class="flex-1">
            <table class="w-full border-collapse border border-gray-300 text-xs">
              <thead>
                <tr class="bg-gray-100">
                  <th class="border border-gray-300 p-2 text-left">SUBJECTS</th>
                  <th class="border border-gray-300 p-2">1st CA 20%</th>
                  <th class="border border-gray-300 p-2">2nd CA 20%</th>
                  <th class="border border-gray-300 p-2">Exam 60%</th>
                  <th class="border border-gray-300 p-2">Total 100%</th>
                  <th class="border border-gray-300 p-2">Grade</th>
                  <th class="border border-gray-300 p-2">Remark</th>
                </tr>
              </thead>
              <tbody>
                ${result.scores.map(s => `
                  <tr>
                    <td class="border border-gray-300 p-2 font-bold">${s.subject}</td>
                    <td class="border border-gray-300 p-2 text-center">${s.ca1 ?? '—'}</td>
                    <td class="border border-gray-300 p-2 text-center">${s.ca2 ?? '—'}</td>
                    <td class="border border-gray-300 p-2 text-center">${s.exam ?? '—'}</td>
                    <td class="border border-gray-300 p-2 text-center font-bold">${s.total}</td>
                    <td class="border border-gray-300 p-2 text-center font-bold">${s.grade}</td>
                    <td class="border border-gray-300 p-2 text-center text-xs font-bold ${getRemarkColor(s.remark)}">
                      ${s.remark}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <div class="w-64 text-xs">
            <div class="border border-gray-300 mb-4">
              <div class="bg-gray-100 p-2 font-bold text-center">AFFECTIVE TRAITS RATING</div>
              <table class="w-full">
                <tbody>
                  ${result.affectiveTraits.map(t => `
                    <tr class="border-t border-gray-200">
                      <td class="p-2">${t.name}</td>
                      <td class="p-2 text-right font-bold">${t.score}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <div class="border border-gray-300 mb-4">
              <div class="bg-gray-100 p-2 font-bold text-center">PSYCHOMOTOR TRAITS RATING</div>
              <table class="w-full">
                <tbody>
                  ${result.psychomotorTraits.map(t => `
                    <tr class="border-t border-gray-200">
                      <td class="p-2">${t.name}</td>
                      <td class="p-2 text-right font-bold">${t.score}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="border-t border-gray-300 pt-4 text-xs">
          <div class="grid grid-cols-2 gap-4 mb-4">
            <div>
              <p><span class="font-bold">Class Teacher's Name:</span> Mrs. Smith</p>
              <p class="mt-2"><span class="font-bold">Class Teacher's Comment:</span> A very good result. Keep it up.</p>
            </div>
            <div>
              <p><span class="font-bold">Head Teacher's Comment:</span> Excellent performance. Promoted to next class.</p>
            </div>
          </div>

          <div class="flex justify-between items-center mt-8">
            <div class="text-center w-48">
              <div class="border-b border-gray-400 h-10 mb-2 flex items-center justify-center text-xs text-gray-400">Signature Image</div>
              <p class="font-bold">Head Teacher's Signature</p>
            </div>
            <div class="text-center w-48">
              <div class="border-b border-gray-400 h-10 mb-2 flex items-center justify-center text-xs text-gray-400">Signature Image</div>
              <p class="font-bold">Director's Signature</p>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
};

const template2 = (data, config = {}) => {
  const primaryColor = config.primaryColor || '#1f2937';
  const school = data.school || { name: "ST. AUGUSTINE'S COLLEGE", address: "P.M.B. 1045, New Karu, Nasarawa State", contact: "Email: info@staugustines.edu.ng" };
  const student = data.student || { name: "CHIDI OKAFOR", class: "SSS 2 Science", session: "2023/2024", admissionNo: "SA/2022/345", dob: "2008-05-14", age: 16, gender: "Male", house: "Red House", club: "Jets Club", rollNo: "12" };
  const result = data.result || { termEnds: "2024-04-10", nextTermBegins: "2024-05-02", nextTermFees: "₦185,000", scores: [], attendance: { opened: 120, present: 118, absent: 2 }, affectiveTraits: [], psychomotorTraits: [], summary: { totalObtained: 0, totalObtainable: 0, totalSubjects: 0, percentage: 0, grade: '', position: '' }, gradeAnalysis: {} };

  const renderRatingScale = (rating) => {
    return [5, 4, 3, 2, 1].map(val => `
      <td class="border border-gray-300 text-center p-1">
        ${rating === val ? '✓' : ''}
      </td>
    `).join('');
  };

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
          body { font-family: 'Inter', sans-serif; }
        </style>
      </head>
      <body class="bg-white p-6 max-w-5xl mx-auto border border-gray-400 text-xs">
        <div class="flex justify-between items-center mb-4 border-b-2 border-gray-800 pb-2">
          <div class="w-24 h-24 bg-gray-200 flex items-center justify-center text-xs text-gray-500">Crest</div>
          <div class="text-center flex-1 mx-4">
            <h1 class="text-2xl font-bold text-gray-900">${school.name}</h1>
            <p class="text-sm">${school.address}</p>
            <p class="text-xs text-gray-600">${school.contact}</p>
          </div>
          <div class="w-20 h-24 bg-gray-200 flex items-center justify-center text-xs text-gray-500">Photo</div>
        </div>

        <div class="grid grid-cols-4 gap-2 bg-gray-50 p-3 border border-gray-300 mb-4">
          <div><span class="font-bold">Name:</span> ${student.name}</div>
          <div><span class="font-bold">Class:</span> ${student.class}</div>
          <div><span class="font-bold">Session:</span> ${student.session}</div>
          <div><span class="font-bold">Adm. No:</span> ${student.admissionNo}</div>
          
          <div><span class="font-bold">D.O.B:</span> ${student.dob}</div>
          <div><span class="font-bold">Age:</span> ${student.age}</div>
          <div><span class="font-bold">Gender:</span> ${student.gender}</div>
          <div><span class="font-bold">House:</span> ${student.house}</div>
          
          <div><span class="font-bold">Club/Society:</span> ${student.club}</div>
          <div><span class="font-bold">Roll No:</span> ${student.rollNo}</div>
          <div><span class="font-bold">Term Ends:</span> ${result.termEnds}</div>
          <div><span class="font-bold">Next Term:</span> ${result.nextTermBegins}</div>
          
          <div class="col-span-4"><span class="font-bold">Next Term Fees:</span> ${result.nextTermFees}</div>
        </div>

        <div class="flex gap-4 mb-4">
          <div class="flex-1 overflow-x-auto">
            <table class="w-full border-collapse border border-gray-300 text-xs">
              <thead>
                <tr class="text-white" style="background-color: ${primaryColor};">
                  <th class="border border-gray-300 p-2 text-left">COGNITIVE DOMAIN / SUBJECT</th>
                  <th class="border border-gray-300 p-2">C.A. (40)</th>
                  <th class="border border-gray-300 p-2">EXAM (60)</th>
                  <th class="border border-gray-300 p-2">TOTAL (100)</th>
                  <th class="border border-gray-300 p-2">GRADE</th>
                  <th class="border border-gray-300 p-2">POSN</th>
                  <th class="border border-gray-300 p-2">REMARKS</th>
                  <th class="border border-gray-300 p-2">CLASS AVG</th>
                  <th class="border border-gray-300 p-2">PREV TERM</th>
                </tr>
              </thead>
              <tbody>
                ${result.scores.map(s => `
                  <tr>
                    <td class="border border-gray-300 p-2 font-bold">${s.subject}</td>
                    <td class="border border-gray-300 p-2 text-center">${s.ca}</td>
                    <td class="border border-gray-300 p-2 text-center">${s.exam}</td>
                    <td class="border border-gray-300 p-2 text-center font-bold">${s.total}</td>
                    <td class="border border-gray-300 p-2 text-center font-bold">${s.grade}</td>
                    <td class="border border-gray-300 p-2 text-center">${s.position}</td>
                    <td class="border border-gray-300 p-2 text-center">${s.remark}</td>
                    <td class="border border-gray-300 p-2 text-center">${s.classAvg}</td>
                    <td class="border border-gray-300 p-2 text-center">${s.prevTerm || '—'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <div class="w-72 text-xs">
            <div class="border border-gray-300 mb-4">
              <div class="text-white p-2 font-bold text-center" style="background-color: ${primaryColor};">ATTENDANCE SUMMARY</div>
              <table class="w-full">
                <tbody>
                  <tr class="border-t border-gray-200">
                    <td class="p-2">Times School Opened</td>
                    <td class="p-2 text-right font-bold">${result.attendance.opened}</td>
                  </tr>
                  <tr class="border-t border-gray-200">
                    <td class="p-2">No of Times Present</td>
                    <td class="p-2 text-right font-bold">${result.attendance.present}</td>
                  </tr>
                  <tr class="border-t border-gray-200">
                    <td class="p-2">No of Times Absent</td>
                    <td class="p-2 text-right font-bold">${result.attendance.absent}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="border border-gray-300 mb-4">
              <div class="text-white p-2 font-bold text-center" style="background-color: ${primaryColor};">AFFECTIVE DOMAIN</div>
              <table class="w-full border-collapse">
                <thead>
                  <tr class="bg-gray-100">
                    <th class="border border-gray-300 p-1 text-left">Trait</th>
                    <th class="border border-gray-300 p-1 w-6">5</th>
                    <th class="border border-gray-300 p-1 w-6">4</th>
                    <th class="border border-gray-300 p-1 w-6">3</th>
                    <th class="border border-gray-300 p-1 w-6">2</th>
                    <th class="border border-gray-300 p-1 w-6">1</th>
                  </tr>
                </thead>
                <tbody>
                  ${result.affectiveTraits.map(t => `
                    <tr>
                      <td class="border border-gray-300 p-1">${t.name}</td>
                      ${renderRatingScale(t.rating)}
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
};

const template3 = (data) => {
  const school = data.school || { name: "FEDERAL GOVERNMENT COLLEGE", logo: "", crest: "" };
  const student = data.student || { name: "AMAKA OBI", admissionNo: "FGC/2021/890", class: "SS 3 Alpha", noInClass: 45, status: "PASSED" };
  const result = data.result || { term: "Third Term / CUMULATIVE", session: "2023/2024", summary: { obtainable: 1000, obtained: 850, average: 85.0, position: "3rd" }, scores: [], vacationDate: "2024-07-20", resumptionDate: "2024-09-10", affectiveTraits: [], psychomotorTraits: [] };

  const renderRatingScale = (rating) => {
    return [5, 4, 3, 2, 1].map(val => `
      <td class="border border-gray-300 text-center p-1">
        ${rating === val ? '✓' : ''}
      </td>
    `).join('');
  };

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
          body { font-family: 'Inter', sans-serif; }
        </style>
      </head>
      <body class="bg-white p-6 max-w-5xl mx-auto border-2 border-gray-800 text-xs">
        <div class="flex justify-between items-center mb-4 text-center border-b-2 border-gray-800 pb-2">
          <div class="w-20 h-20 bg-gray-200 flex items-center justify-center text-xs text-gray-500">Logo</div>
          <div class="flex-1">
            <div class="w-16 h-16 bg-gray-200 mx-auto mb-1 flex items-center justify-center text-xs text-gray-500">Coat of Arms</div>
            <h1 class="text-2xl font-extrabold text-gray-900">${school.name}</h1>
            <p class="text-sm font-bold uppercase">Continuous Assessment and Cumulative Report</p>
          </div>
          <div class="w-20 h-20 bg-gray-200 flex items-center justify-center text-xs text-gray-500">Logo</div>
        </div>

        <div class="grid grid-cols-4 gap-2 bg-gray-100 p-3 border border-gray-300 mb-4 font-bold">
          <div>Name: <span class="font-normal">${student.name}</span></div>
          <div>Adm. No: <span class="font-normal">${student.admissionNo}</span></div>
          <div>Class: <span class="font-normal">${student.class}</span></div>
          <div>No. in Class: <span class="font-normal">${student.noInClass}</span></div>
          
          <div>Term: <span class="font-normal">${result.term}</span></div>
          <div>Session: <span class="font-normal">${result.session}</span></div>
          <div class="col-span-2">Status: <span class="font-bold ${student.status === 'PASSED' ? 'text-green-700' : 'text-red-700'}">${student.status}</span></div>
        </div>

        <div class="grid grid-cols-4 gap-2 bg-gray-800 text-white p-2 text-center font-bold mb-4">
          <div>Total Obtainable: ${result.summary.obtainable}</div>
          <div>Total Obtained: ${result.summary.obtained}</div>
          <div>Average: ${result.summary.average}%</div>
          <div>Position: ${result.summary.position}</div>
        </div>

        <div class="overflow-x-auto mb-4">
          <table class="w-full border-collapse border border-gray-400 text-xs">
            <thead>
              <tr class="bg-gray-200">
                <th class="border border-gray-400 p-2 text-left" rowspan="2">SUBJECT</th>
                <th class="border border-gray-400 p-1 text-center bg-blue-50" colspan="8">CURRENT TERM</th>
                <th class="border border-gray-400 p-1 text-center bg-green-50" colspan="8">CUMULATIVE SUMMARY</th>
              </tr>
              <tr class="bg-gray-100">
                <th class="border border-gray-400 p-1 bg-blue-50">1st CA</th>
                <th class="border border-gray-400 p-1 bg-blue-50">2nd CA</th>
                <th class="border border-gray-400 p-1 bg-blue-50">3rd CA</th>
                <th class="border border-gray-400 p-1 bg-blue-50">EXAM</th>
                <th class="border border-gray-400 p-1 bg-blue-50">Total</th>
                <th class="border border-gray-400 p-1 bg-blue-50">Grade</th>
                <th class="border border-gray-400 p-1 bg-blue-50">Posn</th>
                <th class="border border-gray-400 p-1 bg-blue-50">Remarks</th>
                <th class="border border-gray-400 p-1 bg-green-50">1st T</th>
                <th class="border border-gray-400 p-1 bg-green-50">2nd T</th>
                <th class="border border-gray-400 p-1 bg-green-50">3rd T</th>
                <th class="border border-gray-400 p-1 bg-green-50">Cum. Total</th>
                <th class="border border-gray-400 p-1 bg-green-50">Cum. Avg</th>
                <th class="border border-gray-400 p-1 bg-green-50">Cum. Grade</th>
                <th class="border border-gray-400 p-1 bg-green-50">Cum. Posn</th>
                <th class="border border-gray-400 p-1 bg-green-50">Remarks</th>
              </tr>
            </thead>
            <tbody>
              ${result.scores.map(s => `
                <tr>
                  <td class="border border-gray-400 p-2 font-bold">${s.subject}</td>
                  <td class="border border-gray-400 p-1 text-center bg-blue-50">${s.ca1 ?? '—'}</td>
                  <td class="border border-gray-400 p-1 text-center bg-blue-50">${s.ca2 ?? '—'}</td>
                  <td class="border border-gray-400 p-1 text-center bg-blue-50">${s.ca3 ?? '—'}</td>
                  <td class="border border-gray-400 p-1 text-center bg-blue-50">${s.exam ?? '—'}</td>
                  <td class="border border-gray-400 p-1 text-center font-bold bg-blue-50">${s.total}</td>
                  <td class="border border-gray-400 p-1 text-center font-bold bg-blue-50">${s.grade}</td>
                  <td class="border border-gray-400 p-1 text-center bg-blue-50">${s.position}</td>
                  <td class="border border-gray-400 p-1 text-center bg-blue-50">${s.remark}</td>
                  <td class="border border-gray-400 p-1 text-center bg-green-50">${s.t1 ?? '—'}</td>
                  <td class="border border-gray-400 p-1 text-center bg-green-50">${s.t2 ?? '—'}</td>
                  <td class="border border-gray-400 p-1 text-center bg-green-50">${s.t3 ?? '—'}</td>
                  <td class="border border-gray-400 p-1 text-center font-bold bg-green-50">${s.cumTotal}</td>
                  <td class="border border-gray-400 p-1 text-center bg-green-50">${s.cumAvg.toFixed(1)}</td>
                  <td class="border border-gray-400 p-1 text-center font-bold bg-green-50">${s.cumGrade}</td>
                  <td class="border border-gray-400 p-1 text-center bg-green-50">${s.cumPosition}</td>
                  <td class="border border-gray-400 p-1 text-center bg-green-50">${s.remark}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </body>
    </html>
  `;
};

const template4 = (data, config = {}) => {
  const primaryColor = config.primaryColor || '#fb923c';
  const school = data.school || { name: "LITTLE ANGELS ACADEMY", url: "www.littleangels.edu", address: "7 Nursery Road, Lekki, Lagos", phone: "+234 802 345 6789", color: "#ec4899" };
  const student = data.student || { name: "Sophie Adams", teacher: "Ms. Evelyn", class: "Kindergarten 1", year: "2023/2024" };
  const result = data.result || { scores: [], gradingScale: [], attendance: { absences: 0, tardies: 0, earlyDismissals: 0 }, comment: "" };

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
          body { font-family: 'Inter', sans-serif; }
        </style>
      </head>
      <body class="bg-white max-w-4xl mx-auto font-sans shadow-lg border border-gray-100">
        <div class="text-white p-6 flex justify-between items-center" style="background-color: ${primaryColor}">
          <div>
            <h1 class="text-3xl font-extrabold uppercase tracking-wide">${school.name}</h1>
            <p class="text-sm opacity-90">Progress Report</p>
          </div>
          <div class="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center text-xs backdrop-blur-sm">Logo</div>
        </div>

        <div class="p-8">
          <div class="grid grid-cols-2 gap-8 mb-8 bg-gray-50 p-4 rounded-xl">
            <div>
              <p class="text-xs text-gray-500 uppercase font-semibold">Student Name</p>
              <p class="text-xl font-bold text-gray-900">${student.name}</p>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <p class="text-xs text-gray-500 uppercase font-semibold">Teacher</p>
                <p class="font-medium text-gray-800">${student.teacher}</p>
              </div>
              <div>
                <p class="text-xs text-gray-500 uppercase font-semibold">Grade/Class</p>
                <p class="font-medium text-gray-800">${student.class}</p>
              </div>
              <div>
                <p class="text-xs text-gray-500 uppercase font-semibold">School Year</p>
                <p class="font-medium text-gray-800">${student.year}</p>
              </div>
            </div>
          </div>

          <div class="flex gap-8 mb-8">
            <div class="flex-1">
              <h2 class="text-lg font-bold text-gray-800 mb-3">Learning Areas</h2>
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b-2 border-gray-200">
                    <th class="text-left py-2 text-gray-600">SUBJECT</th>
                    <th class="text-center py-2 text-gray-600">TERM 1</th>
                    <th class="text-center py-2 text-gray-600">TERM 2</th>
                    <th class="text-center py-2 text-gray-600">TERM 3</th>
                  </tr>
                </thead>
                <tbody>
                  ${result.scores.map(s => `
                    <tr class="border-b border-gray-100 hover:bg-gray-50">
                      <td class="py-3 font-medium text-gray-800">${s.subject}</td>
                      <td class="text-center py-3 text-gray-600">${s.q1 ?? '—'}</td>
                      <td class="text-center py-3 text-gray-600">${s.q2 ?? '—'}</td>
                      <td class="text-center py-3 text-gray-600">${s.q3 ?? '—'}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <div class="w-64">
              <div class="bg-gray-50 p-4 rounded-xl border border-gray-100">
                <h2 class="text-sm font-bold text-gray-800 mb-3">Grading Scale</h2>
                <div class="space-y-3 text-xs">
                  ${result.gradingScale.map(g => `
                    <div class="flex flex-col">
                      <span class="font-bold text-gray-900">${g.grade}</span>
                      <span class="text-gray-500">${g.description}</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-8">
            <div>
              <h2 class="text-lg font-bold text-gray-800 mb-3">Attendance</h2>
              <div class="bg-gray-50 p-4 rounded-xl space-y-2 text-sm border border-gray-100">
                <div class="flex justify-between">
                  <span class="text-gray-600">Absences</span>
                  <span class="font-bold text-gray-900">${result.attendance.absences}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-600">Tardies</span>
                  <span class="font-bold text-gray-900">${result.attendance.tardies}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-600">Early Dismissals</span>
                  <span class="font-bold text-gray-900">${result.attendance.earlyDismissals}</span>
                </div>
              </div>
            </div>

            <div class="col-span-2">
              <h2 class="text-lg font-bold text-gray-800 mb-3">Teacher's Comments</h2>
              <div class="bg-gray-50 p-4 rounded-xl border border-gray-100 h-32 text-sm text-gray-700 italic">
                "${result.comment}"
              </div>
            </div>
          </div>
        </div>

        <div class="bg-gray-100 p-4 text-center text-xs text-gray-500 border-t border-gray-200">
          <p>${school.address} | Phone: ${school.phone}</p>
          <p class="mt-1 font-medium">${school.url}</p>
        </div>
      </body>
    </html>
  `;
};

const template5 = (data, config = {}) => {
  const primaryColor = config.primaryColor || '#2563eb';
  const school = data.school || { name: "SUPREME ACADEMY", address: "Plot 5, Education District, Abuja", contact: "Tel: +234 803 123 4567" };
  const student = data.student || { name: "David Adeleke", class: "JSS 2 Diamond", rollNo: "05", regNo: "SA/JSS2/005", gender: "Male", age: 13, email: "david@example.com" };
  const result = data.result || { term: "FIRST TERM", session: "2023/2024", position: "2nd", grandTotal: 0, average: 0, gradePoint: 0, summary: "", scores: [] };

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
          body { font-family: 'Inter', sans-serif; }
        </style>
      </head>
      <body class="bg-white p-6 max-w-5xl mx-auto border border-gray-200 font-sans text-xs shadow-sm">
        <div class="flex justify-between items-center mb-2">
          <div class="w-16 h-16 bg-gray-100 flex items-center justify-center text-xs text-gray-500">Logo</div>
          <div class="text-center flex-1 mx-4">
            <h1 class="text-2xl font-bold text-gray-900">${school.name}</h1>
            <p class="text-sm">${school.address}</p>
            <p class="text-xs text-gray-600">${school.contact}</p>
          </div>
          <div class="w-16 h-16 bg-gray-100 flex items-center justify-center text-xs text-gray-500">Crest</div>
        </div>

        <div class="text-center mb-4">
          <h2 class="text-sm font-bold uppercase border-y border-gray-300 py-1">
            ${result.term} (TERMLY EXAMINATION) RESULT - ${result.session}
          </h2>
        </div>

        <div class="flex gap-4 mb-4">
          <div class="flex-1 grid grid-cols-4 gap-x-4 gap-y-2 border border-gray-300 p-3 bg-gray-50">
            <div><span class="font-bold">Name:</span> ${student.name}</div>
            <div><span class="font-bold">Position:</span> ${result.position}</div>
            <div><span class="font-bold">Gender:</span> ${student.gender}</div>
            <div><span class="font-bold">Grand Total:</span> ${result.grandTotal}</div>
            
            <div><span class="font-bold">Age:</span> ${student.age}</div>
            <div><span class="font-bold">Average:</span> ${result.average}%</div>
            <div><span class="font-bold">Class:</span> ${student.class}</div>
            <div><span class="font-bold">Roll No:</span> ${student.rollNo}</div>
            
            <div><span class="font-bold">Grade Point:</span> ${result.gradePoint}</div>
            <div><span class="font-bold">Reg No:</span> ${student.regNo}</div>
            <div class="col-span-2"><span class="font-bold">Email:</span> ${student.email}</div>
            
            <div class="col-span-4"><span class="font-bold">Result Summary:</span> <span class="font-bold text-green-700">${result.summary}</span></div>
          </div>
          <div class="w-24 h-24 bg-gray-100 flex items-center justify-center text-xs text-gray-500 border border-gray-300">Photo</div>
        </div>

        <div class="overflow-x-auto mb-4">
          <table class="w-full border-collapse border border-gray-300 text-xs text-center">
            <thead>
              <tr class="bg-gray-100">
                <th class="border border-gray-300 p-1">#</th>
                <th class="border border-gray-300 p-1 text-left">Subject</th>
                <th class="border border-gray-300 p-1">1st Test</th>
                <th class="border border-gray-300 p-1">2nd Test</th>
                <th class="border border-gray-300 p-1">Assign.</th>
                <th class="border border-gray-300 p-1">Project</th>
                <th class="border border-gray-300 p-1">Exam</th>
                <th class="border border-gray-300 p-1">Total</th>
                <th class="border border-gray-300 p-1">Grade</th>
                <th class="border border-gray-300 p-1">Remark</th>
              </tr>
            </thead>
            <tbody>
              ${result.scores.map((s, i) => `
                <tr>
                  <td class="border border-gray-300 p-1">${i + 1}</td>
                  <td class="border border-gray-300 p-1 text-left font-bold">${s.subject}</td>
                  <td class="border border-gray-300 p-1">${s.test1 ?? '—'}</td>
                  <td class="border border-gray-300 p-1">${s.test2 ?? '—'}</td>
                  <td class="border border-gray-300 p-1">${s.assignment ?? '—'}</td>
                  <td class="border border-gray-300 p-1">${s.project ?? '—'}</td>
                  <td class="border border-gray-300 p-1">${s.exam ?? '—'}</td>
                  <td class="border border-gray-300 p-1 font-bold">${s.total}</td>
                  <td class="border border-gray-300 p-1 font-bold">${s.grade}</td>
                  <td class="border border-gray-300 p-1">${s.remark}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div class="flex gap-4 mb-4">
          <div class="flex-1 border border-gray-300 p-4 bg-gray-50">
            <h3 class="font-bold mb-2 text-center text-xs">Cognitive Assessment Summary</h3>
            <div class="flex items-end justify-around h-32 pt-2 border-b border-gray-400">
              ${result.scores.map(s => `
                <div class="flex flex-col items-center w-12">
                  <div class="w-6" style="background-color: ${primaryColor}; height: ${(s.total / 100) * 100}px"></div>
                  <span class="text-xs truncate w-full text-center mt-1" style="font-size: 8px">${s.subject}</span>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="w-48 border border-gray-300 p-2">
            <h3 class="font-bold mb-1 text-center text-xs">Key to Grades</h3>
            <table class="w-full text-xs">
              <tbody>
                <tr><td>70-100</td><td class="font-bold">A</td><td>Excellent</td></tr>
                <tr><td>60-69</td><td class="font-bold">B</td><td>V. Good</td></tr>
                <tr><td>50-59</td><td class="font-bold">C</td><td>Good</td></tr>
                <tr><td>40-49</td><td class="font-bold">D</td><td>Fair</td></tr>
                <tr><td>0-39</td><td class="font-bold">F</td><td>Fail</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </body>
    </html>
  `;
};

const generateResultPDF = async (data, templateId, config = {}) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  } catch (err) {
    console.error("Failed to launch Puppeteer:", err);
    throw new Error("PDF generation service is currently unavailable.");
  }

  const page = await browser.newPage();
  
  let html = '';
  if (templateId === 'template1') {
    html = template1(data, config);
  } else if (templateId === 'template2') {
    html = template2(data, config);
  } else if (templateId === 'template3') {
    html = template3(data, config);
  } else if (templateId === 'template4') {
    html = template4(data, config);
  } else if (templateId === 'template5') {
    html = template5(data, config);
  } else {
    html = template1(data, config);
  }
  
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  
  await browser.close();
  return pdf;
};

module.exports = {
  generateResultPDF,
  template1,
  template2,
  template3,
  template4,
  template5
};
