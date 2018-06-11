const die = require('./common').die,
      { ACT_COLLECT_STATS, ACT_STATS, ACT_FETCH, ACT_CHECK_BITBUCKET, ACT_UPDATE_FAILED } = require('./common'),
      { spawn, exec } = require('child-process-promise'),
      request = require('request-promise'),
      JsonDB = require('node-json-db'),
      cheerio = require('cheerio'),
      colors = require('colors'),
      blue = colors.blue,
      cyan = colors.cyan,
      yellow = colors.yellow,
      green = colors.green,
      red = colors.red,
      path = require('path'),
      fs = require('fs'),
      { promptDirMaybe, promptActionsMaybe, promptCredentialsMaybe,
        promptAddToIgnore, promptSaveLogin } = require('./prompts'),
      moment = require('moment'),
      _ = require('underscore');

require('console.table');

const S_CLONED = 'cloned',
      S_UPDATED = 'updated',
      S_UPDATED_FAIL = 'update_failure',
      S_NO_GIT = 'no_git',
      S_CLONE_FAILED = 'clone_failure';

// Bisness logic start here
async function main() {
  const argv = processArgs();
  const rootDir = await promptDirMaybe({dir: argv.d}),
        db = new JsonDB(path.join(rootDir, '.sync-jira-git.db'),
                        true,   // save per each push
                        true);  // humanized db
  let actions = [];
  if (argv.f) {actions.push(ACT_FETCH);}
  if (argv.c) {actions.push(ACT_CHECK_BITBUCKET);}
  if (argv.s) {actions.push(ACT_STATS);}
  if (argv.g) {actions.push(ACT_COLLECT_STATS);}
  if (argv.t) {actions.push(ACT_UPDATE_FAILED);}

  const autoYes = argv.y;

  actions = await promptActionsMaybe({actions});

  const wantCheckBitbucket = _.contains(actions, ACT_CHECK_BITBUCKET);
  const wantFetch = _.contains(actions, ACT_FETCH);
  const wantStats = _.contains(actions, ACT_STATS);
  const wantCollectStats = _.contains(actions, ACT_COLLECT_STATS);
  const wantUpdateFailed = _.contains(actions, ACT_UPDATE_FAILED);

  if (wantCheckBitbucket) {
    await checkBitbucketAndClone({db, rootDir, autoYes});
  }

  if (wantFetch) {
    await updateOldRepositories({db, rootDir, autoYes, wantUpdateFailed});
  }

  if (wantCollectStats) {
    await collectStats({db, rootDir});
  }

  if (wantStats || wantFetch || wantCheckBitbucket || wantCollectStats) {
    await printStats({db});
  }
}

exports.run = function() {
  main().catch(die);
};

function processArgs() {
  const o = require('optimist')
          .usage(
            `
Parse bitbucket, clone and fetch repositaries.
sync-jira-git --dir <dir>`)
          .boolean('f')
          .alias('y', 'yes')
          .describe('y', 'Automatic yes to prompts')
          .boolean('t')
          .alias('t', 'try-failed')
          .describe('t', 'Try to update failed again repositaries too. Use it with -f')
          .alias('d', 'dir')
          .describe('d', 'Directory where to clone projects')
          .boolean('f')
          .alias('f', 'fetch')
          .describe('f', 'Fetch repositories in subdirs')
          .boolean('s')
          .alias('s', 'stats')
          .describe('s', 'Print stats')
          .boolean('g')
          .alias('g', 'git-stats')
          .describe('g', 'Collect git stats')
          .boolean('c')
          .alias('c', 'check-bitbucket')
          .describe('c', 'Check bitbucket for new repositories')
          .boolean('h')
          .alias('h', 'help');
  const argv = o.argv;

  if (argv.h) {
    o.showHelp();
    process.exit();
  }
  return argv;
}

async function checkBitbucketAndClone({db, rootDir, autoYes}) {
  const jiraCredentialsFromDb = safeDbGet(db, '/credentials', {});
  const promptedJiraCredentials = await promptCredentialsMaybe(jiraCredentialsFromDb); // {login, password, domain}
  if (!jiraCredentialsFromDb.domain) {saveDomain(promptedJiraCredentials.domain);}
  if (!jiraCredentialsFromDb.login) {
    if (await promptSaveLogin()) {saveLogin(promptedJiraCredentials.login);}
  }
  const jar = await loginToJira(promptedJiraCredentials);
  const domain = promptedJiraCredentials.domain;
  const projects = await getProjects({jar, domain}); // Return [{url, projectName}]
  console.log(`Found ${projects.length} projects`);

  let repositaryStats = {};

  for (let project of _.map(projects)) {
    const projectKey = project.key;
    const repositories = await getRepositaries({key: projectKey, jar, domain}); // Return [{url, repoName}]
    const projectName = project.projectName,
          projectDirectory = path.join(rootDir, projectName);
    console.log(`Project ${cyan(project.projectName)} contains ${cyan(repositories.length)} repositorie(s)`);
    for (let repository of repositories) {
      const {cloneUrl, repoName} = repository;
      const directory = path.join(projectDirectory, repoName);
      // Clone maybe
      let status;
      if (!fs.existsSync(path.join(directory, '.git'))) {
        await spawn('rm', ['-rf', directory]);
        const status = await cloneRepositary({cloneUrl, directory});
        const p = projectName + '/' + repoName;
        if (status) {
          dbSaveInfo(p, {status: S_CLONED, updated: new Date().toUTCString()});
        } else {
          dbSaveInfo(p, {status: S_CLONE_FAILED});
        }
      }
    }
  }

  // misc
  function saveDomain(domain) {db.push('/credentials', {domain: domain}, false);}
  function saveLogin(login) {db.push('/credentials', {login: login}, false);}
  function dbSaveInfo(repo, info = {}) {
    return db.push('/projects/' + repo, info, false);
  }
}

async function loginToJira({login, password, domain}) {
  let jar = request.jar(),
      res = await request.post({
      url: `${domain}/j_atl_security_check`,
      simple: false,
      resolveWithFullResponse: true,
      form: {
        j_password: password,
        j_username: login
      },
      jar: jar
    });

  if (res.statusCode === 302 && res.headers.location.indexOf('login') == -1) {
    console.log('Successfully logged in using account '.green + blue(login));
    return jar;
  }

  console.error(`Fail to login to ${blue(domain)} using login ${blue(login)}, check credentials`);
  return die();
}

async function getProjects({jar, domain}) {
  const url = domain + '/rest/api/latest/projects?limit=999';
  const res = await request.get({url, jar});
  return JSON.parse(res).values.map(({key, name}) => ({key: key, projectName: name}));
}

async function getRepositaries({key, jar, domain}) {
  const url = domain + `/rest/api/latest/projects/${key}/repos?limit=100`;
  const res = await request.get({url, jar});
  return JSON.parse(res).values.map(({slug, links}) => {
    links.clone.find((it) => 'ssh')
    const sshLink = links.clone.find((it) => it.name == 'ssh');
    const altLink = links.clone[0]
    const link = sshLink || altLink || {}
    return {
      repoName: slug,
      cloneUrl: link.href
    }
  })
}

async function cloneRepositary({cloneUrl, directory}) {
  if (!cloneUrl) {
    console.log(red(`Git repo for ${directory} no found! (no "[data-clone-url]"`));
    return false;
  }
  console.log(`Cloning "${blue(cloneUrl)}" to "${blue(directory)}"`);
  await spawn('mkdir', ['-p', directory]);
  await spawn('git', ['clone', cloneUrl, '.'], {
    cwd: directory,
    stdio: ['ignore', process.stdout, process.stderr]});
  return true;
}

async function updateOldRepositories({db, rootDir, autoYes, wantUpdateFailed}) {
  for (let project of getDirectories(rootDir)) {
    const projectPath = path.join(rootDir, project);
    for (let repository of getDirectories(projectPath)) {
      const repoPath = path.join(projectPath, repository);
      const repoName = project + '/' + repository;
      if (fs.existsSync(path.join(repoPath, '.git'))) {
        let info = dbGetInfo(repoName);
        if (info.ignore) {
          if (wantUpdateFailed && info.status == S_UPDATED_FAIL) {
            console.log(`Retry update "${cyan(repoPath)}"`);
          } else {
            continue;
          }
        } {
          console.log(`Updating "${cyan(repoPath)}"`);
        }
        let ok;
        try {
          try {
            await spawn('git', ['fetch'], {cwd: repoPath, stdio: ['ignore', process.stdout, process.stderr]})
          } catch (e) {
            console.log(yellow(`Failed to fetch repo ${rootDir}, I will try again`));
            await spawn('git', ['fetch'], {cwd: repoPath, stdio: ['ignore', process.stdout, process.stderr]})
          }
          ok = true;
        } catch (e) {
          console.log(red(`Failed to fetch repo ${rootDir}, you might want to remove this directory or add to ignore list`));
          if (await promptAddToIgnore(repoName, autoYes)) {
            dbSaveInfo(repoName, {status: S_UPDATED_FAIL, ignore: true,});
          } else {
            dbSaveInfo(repoName, {status: S_UPDATED_FAIL});
          }
        }
        if (ok) {
          const now = new Date();
          dbSaveInfo(repoName, {updated: now.toUTCString(), status: S_UPDATED});
        }
      } else {
        console.log(`Direcory "${repoPath}" have no .git`.red);
        if (await promptAddToIgnore(repoName, autoYes)) {
          dbSaveInfo(repoName, {status: S_NO_GIT, ignore: true});
        } else {
          dbSaveInfo(repoName, {status: S_NO_GIT,});
        }
      }
    }
  }

  function dbGetInfo(repo) {
    return safeDbGet(db, `/projects/${repo}`, {});
  }
  function dbSaveInfo(repo, info = {}) {
    return db.push('/projects/' + repo, info, false);
  }
  function getDirectories (srcpath) {
    return fs.readdirSync(srcpath)
      .filter(file => fs.statSync(path.join(srcpath, file)).isDirectory());
  }
}

async function collectStats({db, rootDir}) {
  console.log(`Collecting stats`);
  let n = 1;
  for (let project of getDirectories(rootDir)) {
    const projectPath = path.join(rootDir, project);
    for (let repository of getDirectories(projectPath)) {
      const repoPath = path.join(projectPath, repository);
      const repoName = project + '/' + repository;
      if (fs.existsSync(path.join(repoPath, '.git'))) {
        // progress
        process.stdout.write(' ' + n + ' ' + repoName + ' '.repeat(40) + '\r');
        n++;

        let info = dbGetInfo(repoName);
        if (info.ignore) {
          continue;
        }
        try {
          let stats = {};
          if (!info.firstCommitDate || !info.firstCommitAut)  {
            const result = await exec('git log --format="format:%ci!!!%an" origin/master --reverse | head -n 1', {cwd: repoPath});
            stats.sFirstCommitDate = result.stdout.replace(/\n/, '').replace(/!!!.*$/, '');
            stats.sFirstCommitAut = result.stdout.replace(/\n/, '').replace(/.*!!!/, '');
          }
          {
            const result = await exec('git log --format="format:%ci!!!%an" origin/master | head -n 1', {cwd: repoPath});
            stats.sLastCommitDate = result.stdout.replace(/\n/, '').replace(/!!!.*$/, '');
            stats.sLastCommitAut = result.stdout.replace(/\n/, '').replace(/.*!!!/, '');
          }
          {
            const result = await exec('git log --pretty=oneline origin/master | wc -l ', {cwd: repoPath});
            stats.commits = +result.stdout.replace(/\n/, '');
          }
          {
            const result = await exec('git log --pretty=oneline --since "1 month ago" origin/master | wc -l ', {cwd: repoPath});
            stats.commitsMonth = +result.stdout.replace(/\n/, '');
          }

          if (!_.isEmpty(stats)) {
            stats.sUpdate = new Date().toUTCString();
          }
          dbSaveInfo(repoName, stats);
        } catch (e) {}
      }
    }
  }
  console.log(`Done. Project ${n}` + ' '.repeat(50));

  function dbGetInfo(repo) {
    return safeDbGet(db, `/projects/${repo}`, {});
  }
  function dbSaveInfo(repo, info = {}) {
    return db.push('/projects/' + repo, info, false);
  }
  function getDirectories (srcpath) {
    return fs.readdirSync(srcpath)
      .filter(file => fs.statSync(path.join(srcpath, file)).isDirectory());
  }
}

async function printStats({db}) {
  const projects = safeDbGet(db, '/projects', {});

  const cColors = [green, cyan, yellow, blue, red];
  let cNextColor = 0;
  const cNameColors = {};
  const stats = _.chain(projects)
          .reduce((memo, repos, project) => {
            const items = _.map(repos, (info, repo) => {
              return _.extend({
                name: blue(project) + '/' + repo}, info);
            });
            memo.push(items);
            return memo;
          }, [])
          .flatten()
          .map(humanizeDates('updated'))
          .map(humanizeDates('sFirstCommitDate'))
          .map(humanizeDates('sLastCommitDate'))
          .map(it => {
            it.ignore = it.ignore ? red('Ignore') : '';
            return it;
          })
          .map(it => {
            switch(it.status) {
            case S_NO_GIT: it.status = yellow('No git'); break;
            case S_UPDATED: it.status = green('Updated'); break;
            case S_UPDATED_FAIL: it.status = red('Update_Failure'); break;
            case S_CLONED: it.status = green('Cloned'); break;
            case S_CLONE_FAILED: it.status = green('Clone_Failure'); break;
            default: it.status = it.status;
            }
            return it;
          })
          .map(colorizeNames('sFirstCommitAut'))
          .map(colorizeNames('sLastCommitAut'))
          .map(it => {
            return {
              Name: it.name,
              Updated: it.updated,
              Status: it.status,
              Ignore: it.ignore,
              Commits: it.commits,
              'Init Author': it.sFirstCommitAut,
              When: it.sFirstCommitDate,
              'Last Author': it.sLastCommitAut,
              'When Last Com': it.sLastCommitDate,
              'Com. Last Mo.': it.commitsMonth ? it.commitsMonth : '',
            };
          })
          .value();
  console.table(stats);

  function humanizeDates(propName) {
    return function(it) {
      try {
        const date = moment(new Date(it[propName]));
        const diffDays = moment().diff(date, 'days');
        it[propName] = it[propName] ? date.fromNow(true) : '';
        if (diffDays > 300) {
          it[propName] = blue(it[propName]);
        } else if (diffDays > 60) {
          it[propName] = green(it[propName]);
        }
      } catch(e) {console.log(e)}
      return it;
    }
  }

  function colorizeNames(propName) {
    return function(it) {
      const name = it[propName];
      if (!cNameColors[name]) {
        cNameColors[name] = cColors[cNextColor % (cColors.length)];
        cNextColor++;
      }
      it[propName] = cNameColors[name](name);
      return it;
    }
  }
}
async function get({url, jar}) {
  return await request.get({url, jar: jar}).catch(() => {
    console.error(`Fail to fetch "${url}`);
    return null;
  });
}

function safeDbGet(db, what, defaultValue=null) {try { return db.getData(what);} catch (e) {return defaultValue;}}
