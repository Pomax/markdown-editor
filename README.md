# Pomax's Markdown Editor

A GitHub-flavoured markdown editor proof of concept built using the web stack and running in Tauri (a Rust alternative to the idiotically bloated Electron), built to make editing _actual_ documents (e.g. 50k+ word documents like [https://pomax.github.io/are-we-flying](https://pomax.github.io/are-we-flying)) relatively painless.

<img src="./editor.png" style="width: 90%;" />

## Current version: v3.0.0

See the [release log](./RELEASE_LOG.md) for what's new in this version.

### Downloads

This editor is released as a single executable. The current download links are:

- Windows: [Markdown-Editor.exe](https://github.com/Pomax/Pomax-s-Markdown-Editor/releases/download/v3.0.0/Markdown-Editor.exe)
- MacOS: [Markdown-Editor.dmg](https://github.com/Pomax/Pomax-s-Markdown-Editor/releases/download/v3.0.0/Markdown-Editor.dmg)
- Linux: [Markdown-Editor.deb](https://github.com/Pomax/Pomax-s-Markdown-Editor/releases/download/v3.0.0/Markdown-Editor.deb)

Previous versions can be found over on the [Releases](https://github.com/Pomax/Pomax-s-Markdown-Editor/releases/latest) page.

Alternatively, of course, you can just clone the repo, install all the dependencies, and then run the start script from the `scripts` directory.

## So... what is this?

I needed a standalone, GitHub flavoured markdown editor that can open individual files, has both wysiwyg and plain source modes with seamless toggling between those, has *full* "arbitrary html in markdown" support, _including stylesheets_, and the ability to load 50,000+ word documents in a way that edits are (near) immediate instead of trying to update a single, giant, string. Which rules out literally every markdown editor out there. Think of your favourite markdown editor: it fails at least one of those criteria.

So this is that. It's a markdown editor that does what I need, and gets updated anytime I run into something it should do, but can't. Or does something wrong. It's a proof of concept put together using Claude, careful ATTD, and a fuckton of yelling out loud at how much of a piece of shit Anthropic's baby is.

### I don't want to use something made using AI

That's fine. This is a tool that ***I*** need. I'm putting it up on GitHub with a public domain license because that's what I do with almost everything I make, and if you don't want to use this, no one's forcing you to use it. Heck no one even forced you to make it this far in the README, just close this tab; no hard feelings.

## Running from source

There are prebuilt executables, but if you want to run the project from source, compiled on your own machine, go for it.

### Prerequisites

Software:

- A currently supported version of Node.js (I recommend using [nvm](https://www.nvmnode.com/guide/download.html))
- [Rust](https://rust-lang.org/tools/install)

Build tools:

- On Windows, the Microsoft C++ build tools and the WebView2 runtime
- on macOS, the Xcode command line tools
- on Linux, the WebKitGTK 4.1 development packages. 

### Installation

```sh
npm install --ignore-scripts
npm run setup
```

The setup script installs the Playwright Firefox browser used for integration testing, so it's technically optional if all you want to do is compile the editor, but like... you might as well, so you can run the tests to make sure everything works?

### Building

For Windows users, run `scripts\build.bat`, for MacOS and Linux, run `./scripts/build.sh`

### Running the build executable

For Windows users, run `scripts\run.bat`, for MacOS and Linux, run `./scripts/run.sh`

### Testing

You run the full test suite using the `scripts\test.bat` or `./scripts/test.sh` scripts. Nice and simple. This will run linting, formatting, consistency testing, unit testing, the backend's Rust tests, and integration testing.

## License

I didn't write this code, and AI can't be trusted, so this project is Public Domain. Literally do with it what you want, I'm only losing money on this while I figure out a way in which these tools make sense.