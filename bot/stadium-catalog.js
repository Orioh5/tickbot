'use strict';

// Stand name → display block numbers used by the web zone picker.
// These are the 3-digit labels shown in the dashboard UI; not all map 1:1
// to the visual labels the ticketing site returns from the live page.
// For accurate section numbers use GameDiscoveryService.discoverSections().
// ponytail: static copy of STADIUM_ZONES from public/app.js; update both if zones change
module.exports = {
  'Upper Avi Ran': ['201', '202', '203', '204', '205', '206', '207', '208', '209', '210', '211', '212'],
  'Gold':          ['401', '402', '403', '404', '405', '406', '407', '408', '409', '410'],
  'Upper East':    ['218', '219', '220', '221', '222'],
  'Silver':        ['301', '302', '303', '304', '305', '306', '307', '308', '309', '310', '311', '312'],
  'Lower Avi Ran': ['101', '102', '103', '104', '105', '106', '107', '108', '109'],
  'Lower East':    ['114', '115', '116', '117', '118'],
  'South Lower':   ['123', '124', '125', '126', '127', '128'],
  'South Upper':   ['228', '229', '230', '231', '232', '233', '234'],
  'North Family':  ['110', '111', '112', '113', '213', '214', '215', '216', '217'],
  'South Family':  ['119', '120', '121', '122', '223', '224', '225', '226', '227'],
};
