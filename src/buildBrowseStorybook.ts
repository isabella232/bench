import { Tick, timers } from 'exectimer';
import { sync as spawnSync } from 'cross-spawn';
import du from 'du';
import fs from 'fs';
import path from 'path';
import rimraf from 'rimraf';
import puppeteer from 'puppeteer';

import { resetStats, makeStatsServer, puppeteerArgs } from './helpers/timing';
import { makeStaticServer, STATIC_STORYBOOK_PORT } from './helpers/static';

const STDIO = 'inherit';
const BUILD_DIR = 'storybook-static';

const SCRIPT_REGEX = /<script src="(.[^"]*\.js)">/g;
const logger = console;

const getScripts = (html: string) => {
  // <script src="runtime~main.6a9b04192e3176eff72a.bundle.js">
  return Array.from(html.matchAll(SCRIPT_REGEX)).map(m => m[1]);
};

const bundleSize = async (
  buildDir: string,
  prefix: string,
  iframeScripts: string[],
  indexScripts: string[]
) => {
  const files = fs.readdirSync(buildDir);
  const preview = iframeScripts.find(f => f.startsWith(prefix));
  const manager = indexScripts.find(f => f.startsWith(prefix));
  if (!manager || !preview) {
    throw new Error(
      `Unexpected matches for '${prefix}': ${JSON.stringify({
        manager,
        preview,
      })}`
    );
  }
  return {
    manager: await du(path.join(buildDir, manager)),
    preview: await du(path.join(buildDir, preview)),
  };
};

const safeDu = async (filePath: string) => {
  try {
    return await du(filePath);
  } catch {
    return 0;
  }
};

export const bundleSizes = async (buildDir: string) => {
  const iframe = getScripts(
    fs.readFileSync(path.join(buildDir, 'iframe.html')).toString()
  );
  const index = getScripts(
    fs.readFileSync(path.join(buildDir, 'index.html')).toString()
  );
  const main = await bundleSize(buildDir, 'main', iframe, index);
  const runtime = await bundleSize(buildDir, 'runtime', iframe, index);
  const vendors = await bundleSize(buildDir, 'vendors', iframe, index);
  const docsDll = await safeDu(
    path.join(buildDir, 'sb_dll', 'storybook_docs_dll.js')
  );
  const uiDll = await safeDu(
    path.join(buildDir, 'sb_dll', 'storybook_ui_dll.js')
  );

  return {
    manager: {
      total: main.manager + runtime.manager + vendors.manager,
      main: main.manager,
      runtime: runtime.manager,
      vendors: vendors.manager,
      uiDll,
    },
    preview: {
      total: main.preview + runtime.preview + vendors.preview,
      main: main.preview,
      runtime: runtime.preview,
      vendors: vendors.preview,
      docsDll,
    },
  };
};

export const cleanup = async () => {
  rimraf.sync(BUILD_DIR);
};

export const buildBrowseStorybook = async (extraFlags: string[]) => {
  console.log('measuring build-storybook');

  Tick.wrap(function build(done: () => void) {
    spawnSync('yarn', ['build-storybook', ...extraFlags], { stdio: STDIO });
    done();
  });

  let resolve: any;
  const promise = new Promise((res: any) => {
    resolve = res;
  });

  const stats = resetStats();
  const browser = await puppeteer.launch({ args: puppeteerArgs });

  const staticServer = await makeStaticServer();

  let statsServer: any;
  statsServer = await makeStatsServer(stats, async () => {
    logger.log('resolving browse');
    resolve();
    logger.log('stopping stats server');
    await statsServer.stop();
    logger.log('stopping static server');
    await staticServer.stop();
    logger.log('closing puppeteer');
    await browser.close();
  });

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${STATIC_STORYBOOK_PORT}/index.html`);

  await promise;

  const build = {
    time: {
      build: timers.build.duration(),
    },
    size: {},
  };

  const bundles = await bundleSizes(BUILD_DIR);
  const browse = {
    size: {
      total: await du(BUILD_DIR),
      ...bundles,
    },
    time: stats.time,
  };

  return { build, browse };
};
