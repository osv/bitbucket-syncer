const spawn = require('child-process-promise').spawn,
      request = require('request-promise'),
      expandHomeDir = require('expand-home-dir'),
      cheerio = require('cheerio'),
      colors = require('colors'),
      blue = colors.blue,
      cyan = colors.cyan,
      red = colors.red,
      fs = require('fs'),
      path = require('path'),
      _ = require('underscore');

const argv = require('optimist')
        .usage('Parse bitbucket, clone and fetch repositaries.' +
               'npm run start --config <config.json>')
        .demand('c')
        .alias('c', 'config')
        .describe('c', 'JSON Config file')
        .boolean('u')
        .alias('u', 'update')
        .describe('u', 'Fetch repositories in subdirs')
        .boolean('n')
        .alias('n', 'no-bitbucket-check')
        .describe('n', 'Do not check bitbucket for new repositories')
      .argv;

const R_CLONED = 1,
      R_EXISTS = 2,
      R_NO_GIT = 3;
const configFileName = argv.c;

const jar = request.jar();
const config = JSON.parse(fs.readFileSync(configFileName));
const homePage = config.bitbucket;
const login = config.login;
const password = config.password;
const gitDirectory = expandHomeDir(config.gitDirectory);

async function main() {

  let bitBucketRepositories = {},
      updatedRepositories = {};

  if (!argv.n) {
    bitBucketRepositories = await parseBitbucketAndSync({rootDir: gitDirectory});
  }

  const totalBitBucketRepositories = _.keys(bitBucketRepositories),
        clonedBitBucketRepositories = _.reduce(bitBucketRepositories, (memo, v, path) => {
          if (v == R_CLONED) {
            memo.push(v);
          }
          return memo;
        }, []);

  if (argv.u) {
    updatedRepositories = await updateOldRepositories({
      rootDir: gitDirectory,
      ignoreDirectories: clonedBitBucketRepositories
    });

  }

  // summary
  console.log('='.repeat(54).green);

  if (!argv.n) {
    console.log(`Total projects in bitbucket ${totalBitBucketRepositories.length}, cloned ${clonedBitBucketRepositories.length}`.green);
  }
  if (argv.u) {
    const updated = _.reduce(updatedRepositories, (memo, v, path) => {
          if (v == R_EXISTS) {
            memo.push(v);
          }
          return memo;
        }, []);
    const bad = _.reduce(updatedRepositories, (memo, v, path) => {
          if (v == R_NO_GIT) {
            memo.push(v);
          }
          return memo;
        }, []);
    console.log(`Fetched git ${updated.length} repositories, dirs without .git dir ${bad.length}`.green);
  }
}

async function parseBitbucketAndSync({rootDir}) {
  try {
    await request.post({
      url: `${homePage}/j_atl_security_check`,
      form: {
        j_password: password,
        j_username: login
      },
      jar: jar
    });
  } catch (e) {
    if (e.statusCode === 302) {
      console.log('Successfully logged in using account '.green + blue(login));
    } else {
      console.log(`Fail to login to ${blue(homePage)} using login ${blue(login)}, check credentials`);
      process.exit(1);
    }
  }

  const projectsPageUrl = homePage + '/projects';
  const projectsPageHtml = await request.get({url: projectsPageUrl, jar: jar});
  const projects = parseProjectsPage(projectsPageHtml);
  console.log(`Found ${projects.length} projects`);

  let repositaries = {}

  for (let i = 0; i < projects.length; i++){
    const project = projects[i];
    const projectRepoUrl = homePage + project.url;
    const projectName = project.projectName;
    const projectRepoHtml = await request.get({url: projectRepoUrl, jar: jar});

    const repositories = parseRepoPage(projectRepoHtml);
    console.log(`Project ${cyan(projectName)} contains ${cyan(repositories.length)} repositorie(s)`);
    const projectDirectory = path.join(rootDir, projectName);

    for (let repository of _.map(repositories)) {
      const isCloned = await syncRepo(projectDirectory, repository)
      repositaries[projectDirectory] = isCloned ? R_CLONED : R_EXISTS;
    }
  }
  return repositaries;
}

async function updateOldRepositories({rootDir, ignoreDirectories}) {
  const projectsInRootDir = getDirectories(rootDir);
  let updatedRepositories = {};
  for (let project of getDirectories(rootDir)) {
    const projectPath = path.join(rootDir, project);
    for (let repository of getDirectories(projectPath)) {
      const repoPath = path.join(projectPath, repository);
      if (fs.existsSync(path.join(repoPath, '.git'))) {
        console.log(`Updating "${cyan(repoPath)}" repo`);
        await spawn('git', ['fetch'], {
          cwd: repoPath,
          stdio: ['ignore', process.stdout, process.stderr]});
        updatedRepositories[repoPath] = R_EXISTS;
      } else {
        console.log(`Direcory "${repoPath}" have no .git`.red);
        updatedRepositories[repoPath] = R_NO_GIT;
      }
    }
  }

  return updatedRepositories;

  function getDirectories (srcpath) {
    return fs.readdirSync(srcpath)
      .filter(file => fs.statSync(path.join(srcpath, file)).isDirectory())
  }
}

async function syncRepo(dir, {url, repoName}) {
  const directory = path.join(dir, repoName);
  if (fs.existsSync(path.join(directory, '.git'))) {
    return false;
  } else {
    await spawn('rm', ['-rf', directory]);
  }

  // fetch
  const reporitoryPageHtml = await get(url);
  const $ = cheerio.load(reporitoryPageHtml);
  const gitRepo = $('li[id="ssh-clone-url"]').attr('data-clone-url');
  console.log(`Cloning "${blue(gitRepo)}"`);
  await spawn('mkdir', ['-p', directory]);
  await spawn('git', ['clone', gitRepo, '.'], {
    cwd: directory,
    stdio: ['ignore', process.stdout, process.stderr]});
  return true;
}

function parseRepoPage(html) {
  const $ = cheerio.load(html);
  return $('.repository-name a').map(function() {
    const el = $(this),
          url = el.attr('href'),
          repoName = el.text();
    return {url, repoName};
  });
}

function parseProjectsPage(html) {
  const $ = cheerio.load(html);
  return $('.project-name a').map(function() {
    const el = $(this),
          url = el.attr('href'),
          projectName = el.text();
    return {url, projectName};
  });
}

async function get(url) {
  return await request.get({url: homePage + url, jar: jar}).catch(() => {
    console.log(`Fail to fetch "${url}`);
    return null;
  });
}

main(configFileName).catch(e => console.log(e));
