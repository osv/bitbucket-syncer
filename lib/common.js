exports.die = function(...args) {
  console.error(...args);
  process.exit(1);
};

// Actions
exports.ACT_FETCH = 1;
exports.ACT_CHECK_BITBUCKET = 2;
exports.ACT_STATS = 3;
exports.ACT_COLLECT_STATS = 4;
exports.ACT_UPDATE_FAILED = 5;
