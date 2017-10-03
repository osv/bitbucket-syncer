const die = require('./common').die,
      { ACT_COLLECT_STATS, ACT_STATS, ACT_FETCH, ACT_CHECK_BITBUCKET } = require('./common'),
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
  actions = await promptActionsMaybe({actions});

  const wantCheckBitbucket = _.contains(actions, ACT_CHECK_BITBUCKET);
  const wantFetch = _.contains(actions, ACT_FETCH);
  const wantStats = _.contains(actions, ACT_STATS);
  const wantCollectStats = _.contains(actions, ACT_COLLECT_STATS);

  if (wantCheckBitbucket) {
    await checkBitbucketAndClone({db, rootDir});
  }

  if (wantFetch) {
    await updateOldRepositories({db, rootDir});
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

async function checkBitbucketAndClone({db, rootDir}) {
  const jiraCredentialsFromDb = safeDbGet(db, '/credentials', {});
  const promptedJiraCredentials = await promptCredentialsMaybe(jiraCredentialsFromDb); // {login, password, domain}
  if (!jiraCredentialsFromDb.domain) {saveDomain(promptedJiraCredentials.domain);}
  if (!jiraCredentialsFromDb.login) {
    if (await promptSaveLogin()) {saveLogin(promptedJiraCredentials.login);}
  }
  const jar = await loginToJira(promptedJiraCredentials);
  const domain = promptedJiraCredentials.domain;
  const projects = await getProject({jar, domain}); // [{url, projectName}]
  console.log(`Found ${projects.length} projects`);

  let repositaryStats = {};

  for (let project of _.map(projects)) {
    const repositories = await getRepositaries({project, jar, domain}); // [{url, repoName}]
    const projectName = project.projectName,
          projectDirectory = path.join(rootDir, projectName);
    console.log(`Project ${cyan(project.projectName)} contains ${cyan(repositories.length)} repositorie(s)`);

    for (let repository of _.map(repositories)) {
      const {url, repoName} = repository;
      const directory = path.join(projectDirectory, repoName);
      // Clone maybe
      let status;
      if (!fs.existsSync(path.join(directory, '.git'))) {
        await spawn('rm', ['-rf', directory]);
        const status = cloneRepositary({url: domain + url, directory, jar});
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

async function getProject({jar, domain}) {
  const projectsPageUrl = domain + '/projects';
  const projectsPageHtml = await request.get({url: projectsPageUrl, jar: jar});
  return parseProjectsPage(projectsPageHtml);

  function parseProjectsPage(html) {
    const $ = cheerio.load(html);
    return $('.project-name a').map(function() {
      const el = $(this),
            url = el.attr('href'),
            projectName = el.text();
      return {url, projectName};
    });
  }
}

async function getRepositaries({project, jar, domain}) {
  const projectRepoUrl = domain + project.url;
  const projectRepoHtml = await request.get({url: projectRepoUrl, jar: jar});

  return parseRepoPage(projectRepoHtml);

  function parseRepoPage(html) {
    const $ = cheerio.load(html);
    return $('.repository-name a').map(function() {
      const el = $(this),
            url = el.attr('href'),
            repoName = el.text();
      return {url, repoName};
    });
  }
}

async function cloneRepositary({url, directory, jar}) {
  const reporitoryPageHtml = await get({url, jar});
  const $ = cheerio.load(reporitoryPageHtml);
  const gitRepo = $('li[id="ssh-clone-url"]').attr('data-clone-url');
  if (!gitRepo) {
    console.log(red(`Git repo for ${url} no found! (no "[data-clone-url]"`));
    console.log(reporitoryPageHtml.yellow);
    return fail;
  }
  console.log(`Cloning "${blue(gitRepo)}" to ${blue(directory)}`);
  await spawn('mkdir', ['-p', directory]);
  await spawn('git', ['clone', gitRepo, '.'], {
    cwd: directory,
    stdio: ['ignore', process.stdout, process.stderr]});
  return true;
}

async function updateOldRepositories({db, rootDir}) {
  for (let project of getDirectories(rootDir)) {
    const projectPath = path.join(rootDir, project);
    for (let repository of getDirectories(projectPath)) {
      const repoPath = path.join(projectPath, repository);
      const repoName = project + '/' + repository;
      if (fs.existsSync(path.join(repoPath, '.git'))) {
        let info = dbGetInfo(repoName);
        if (info.ignore) {
          continue;
        }
        console.log(`Updating "${cyan(repoPath)}"`);
        let ok;
        try {
          await spawn('git', ['fetch'], {cwd: repoPath, stdio: ['ignore', process.stdout, process.stderr]})
          ok = true;
        } catch (e) {
          console.log(red(`Failed to fetch repo ${rootDir}, you might want to remove this directory or add to ignore list`));
          if (await promptAddToIgnore(repoName)) {
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
        if (await promptAddToIgnore(repoName)) {
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
            case S_UPDATED_FAIL: it.status = red('Update failure'); break;
            case S_CLONED: it.status = green('Cloned'); break;
            case S_CLONE_FAILED: it.status = green('Clone failure'); break;
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
