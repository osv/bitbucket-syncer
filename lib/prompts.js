const inquirer = require('inquirer'),
      die = require('./common').die,
      {ACT_STATS, ACT_FETCH, ACT_CHECK_BITBUCKET} = require('./common');
      path = require('path'),
      fs = require('fs'),
      _ = require('underscore');

inquirer.registerPrompt('directory', require('inquirer-directory'));

exports.promptDirMaybe = promptDirMaybe;
exports.promptActionsMaybe = promptActionsMaybe;
exports.promptCredentialsMaybe = promptCredentialsMaybe;
exports.promptSaveLogin = promptSaveLogin;
exports.promptAddToIgnore = promptAddToIgnore;

async function promptDirMaybe({dir}) {
  if (dir && !fs.existsSync(dir)) {
    die(`Directory not exist "${dir}"`);
  }
  if (!dir || !fs.statSync(dir).isDirectory()) {
    return await inquirer.prompt({
      type: 'directory',
      name: 'path',
      message: 'Enter a path where to store clonned directory.\nYou can set dir using `--dir` option',
      basePath: process.cwd()
    }).then((d) => {
      console.log(`Selected directory for clone "${d.path}"`);
      return d.path;
    });
  } else {
    return dir;
  };
}

async function promptActionsMaybe({actions}) {
  if (actions.length) {
    return actions;
  } else {
    const options = [
      {name: 'Fetch exists repositaries', id: ACT_FETCH, checked: true},
      {name: 'Check bitbucket for new repositaries', id: ACT_CHECK_BITBUCKET, checked: true}
    ];
    return await inquirer.prompt({
      type: 'checkbox',
      message: 'What you want to do?',
      name: 'actions',
      choices: options
    }).then(a => a.actions.map((act) => _.findWhere(options, {name: act}).id));
  }
}

async function promptCredentialsMaybe({login, password, domain}) {
  if (!domain) {
    domain = await inquirer.prompt({
      type: 'input',
      message: 'Bitbucket URL',
      name: 'domain',
    }).then(e => e.domain);
  }
  if (!login) {
    login = await inquirer.prompt({
      type: 'input',
      message: `Bitbucket login name for "${domain}"`,
      name: 'login'
    }).then(e => e.login);
  }
  if (!password) {
    password = await inquirer.prompt({
      type: 'password',
      message: `Password for account "${login}" at ${domain}`,
      name: 'password'
    }).then(e => e.password);
  }
  return {login, password, domain};
}

async function promptSaveLogin() {
  return await inquirer.prompt({
    type: 'confirm',
    message: 'Save login',
    name: 'login',
    default: false
  }).then(e => e.login);
}

async function promptAddToIgnore(project) {
  return await inquirer.prompt({
    type: 'confirm',
    message: `Ignore this repo next time "${project}"`,
    name: 'ignore',
    default: true
  }).then(e => e.ignore);
}
