Bitbucket sync tools

## Description

I have lot of projects on bitbucket.
I don't want change dir to project and type git fetch and I don't want clone them each time.
This tool help you automate `git fetch` & `git clone` repositories.

## How does it works?

It parse bitbucket pages for new repositories and exec `git clone`, if directory already exist and have no .git already and it will be **removed** first. Traverse project directory for updating and exec `git fetch` if contains `.git` subfolder.

## Usage

1. Clone this repo and cd to it
2. `npm install -g`
3. Ensure you know about `sync-jira-git --help`
4 Fetch and clone repositories `sync-jira-git -d ~/work/project`
For now only login and domain can be saved. But you still able to save password if ok that password is not secured:

Example in `~/work/project/.sync-jira-git.db.json`
```json
{
    "credentials": {
        "password": "PASSWORD",
        "domain": "https://git.FOO.BAR",
        "login": "LOGIN"
    }
}
```
4. Run `npm run update-all` for fetch and clone repositories to `gitDirectory` or `npm run fetch` to git fetch in all sub directories of `gitDirectory` directory.

## TODO

[X] Ignore project support in config json
[X] Password promt instead of set login/password in config.json
[ ] Github support
