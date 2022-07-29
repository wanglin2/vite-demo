const connect = require("connect");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { init, parse: parseEsModule } = require("es-module-lexer");
const MagicString = require("magic-string");
const { buildSync } = require("esbuild");
const {
  parse: parseVue,
  compileScript,
  rewriteDefault,
  compileTemplate,
} = require("@vue/compiler-sfc");
const serveStatic = require("serve-static");
const WebSocket = require("ws");
const chokidar = require("chokidar");
const LRUCache = require("lru-cache");

const app = connect();
const server = http.createServer(app);
const basePath = path.join("../test/");
const clientPublicPath = "/client.js";
const typeAlias = {
  js: "application/javascript",
  css: "text/css",
  html: "text/html",
  json: "application/json",
};

// 处理裸导入
const parseBareImport = async (js, importer) => {
  await init;
  // 检查模块url是否存在时间戳
  let hast = checkQueryExist(importer, "t");
  importer = removeQuery(importer);
  // 上一次的依赖集合
  const prevImportees = importeeMap.get(importer);
  // 这一次的依赖集合
  const currentImportees = new Set();
  importeeMap.set(importer, currentImportees);
  let parseResult = parseEsModule(js);
  let s = new MagicString(js);
  // 遍历导入语句
  parseResult[0].forEach((item) => {
    // 不是裸导入则替换
    let url = "";
    if (item.n[0] !== "." && item.n[0] !== "/") {
      url = `/@module/${item.n}?import${hast ? "&t=" + Date.now() : ""}`;
    } else {
      url = `${item.n}?import${hast ? "&t=" + Date.now() : ""}`;
    }
    s.overwrite(item.s, item.e, url);
    let importee = removeQuery(url);
    // -> 依赖
    currentImportees.add(importee);
    // 依赖 ->
    ensureMapEntry(importerMap, importee).add(importer);
    console.log(importee, " -> ", importerMap.get(importee));
  });
  // 删除不再依赖的关系
  if (prevImportees) {
    prevImportees.forEach((importee) => {
      if (!currentImportees.has(importee)) {
        // importer不再依赖importee，所以要从importee的依赖集合中删除importer
        const importers = importerMap.get(importee);
        if (importers) {
          console.log("删除依赖", importer);
          importers.delete(importer);
        }
      }
    });
  }
  return s.toString();
};

const imageRE = /\.(png|jpe?g|gif|svg|ico|webp)(\?.*)?$/;
const mediaRE = /\.(mp4|webm|ogg|mp3|wav|flac|aac)(\?.*)?$/;
const fontsRE = /\.(woff2?|eot|ttf|otf)(\?.*)?$/i;

// 检查是否是静态文件
const isStaticAsset = (file) => {
  return imageRE.test(file) || mediaRE.test(file) || fontsRE.test(file);
};

// 读取文件
const readFile = (url) => {
  return fs.readFileSync(path.join(basePath, url), "utf-8");
};

// 去除url的查询参数
const removeQuery = (url) => {
  return url.split("?")[0];
};

// 发送响应
const send = (res, data, type) => {
  res.setHeader("Content-Type", typeAlias[type]);
  res.statusCode = 200;
  res.end(data);
};

// css to js
const cssToJs = (css, id = "") => {
  return `
    const insertStyle = (css) => {
        // 删除之前的标签
        if ('${id}') {
          let oldEl = document.getElementById('${id}')
          if (oldEl) document.head.removeChild(oldEl)
        }
        let el = document.createElement('style')
        el.setAttribute('type', 'text/css')
        el.id = '${id}'
        el.innerHTML = css
        document.head.appendChild(el)
    }
    insertStyle(\`${css}\`)
    export default insertStyle
  `;
};

// 获取url的某个query值
const getQuery = (url, key) => {
  return new URL(path.resolve(basePath, url)).searchParams.get(key);
};

// 判断url的某个query名是否存在
const checkQueryExist = (url, key) => {
  return new URL(path.resolve(basePath, url)).searchParams.has(key);
};

// 拦截方法
const intercepts = {
  html(req, res) {
    let html = readFile("index.html");
    // 查找模块依赖图
    const scriptRE = /(<script\b[^>]*>)([\s\S]*?)<\/script>/gm;
    const srcRE = /\bsrc=(?:"([^"]+)"|'([^']+)'|([^'"\s]+)\b)/;
    html = html.replace(scriptRE, (matched, openTag) => {
      const srcAttr = openTag.match(srcRE);
      if (srcAttr) {
        // 将脚本注册为hmr的导入dep
        const importee = removeQuery(srcAttr[1] || srcAttr[2]);
        ensureMapEntry(importerMap, importee).add(removeQuery(req.url));
        console.log(importee, " -> ", importerMap.get(importee));
      }
      return matched;
    });
    // 注入client.js
    const devInjectionCode = `\n<script type="module">import "${clientPublicPath}"</script>\n`;
    html = html.replace(/<head>/, `$&${devInjectionCode}`);
    send(res, html, "html");
  },
  module(req, res) {
    let pkg = req.url.slice(9).split("?")[0]; // 从/@module/vue?import中解析出vue
    // 获取该模块的package.json
    let pkgJson = JSON.parse(
      fs.readFileSync(
        path.join(basePath, "node_modules", pkg, "package.json"),
        "utf8"
      )
    );
    // 找出该模块的入口文件
    let entry = pkgJson.module || pkgJson.main;
    // 使用esbuild转换成es模块
    let outfile = path.join(`./esbuild/${pkg}.js`);
    buildSync({
      entryPoints: [path.join(basePath, "node_modules", pkg, entry)],
      format: "esm",
      bundle: true,
      outfile,
    });
    let js = fs.readFileSync(outfile, "utf8");
    send(res, js, "js");
  },
  css(req, res) {
    let cssRes = readFile(removeQuery(req.url));
    let type = "";
    if (checkQueryExist(req.url, "import")) {
      // import请求
      cssRes = cssToJs(cssRes, removeQuery(req.url));
      type = "js";
    } else {
      // link请求
      type = "css";
    }
    send(res, cssRes, type);
  },
  async vue(req, res) {
    let vue = readFile(removeQuery(req.url));
    let code = "";
    let descriptor = null;
    // 如果存在缓存则直接使用缓存
    let cached = vueCache.get(removeQuery(req.url));
    if (cached) {
      descriptor = cached;
    } else {
      // 否则进行解析，并且将解析结果进行缓存
      descriptor = parseVue(vue).descriptor;
      vueCache.set(removeQuery(req.url), descriptor);
    }
    // 处理模板请求
    if (getQuery(req.url, "type") === "template") {
      code = compileTemplate({
        source: descriptor.template.content,
      }).code;
      // 模板文件的url要和Vue单文件本身区分开来，否则依赖会被删掉
      code = await parseBareImport(code, removeQuery(req.url) + "/template");
      send(res, code, "js");
      return;
    }
    // 处理样式请求
    if (getQuery(req.url, "type") === "style") {
      // 获取样式块索引
      let index = getQuery(req.url, "index");
      let styleContent = descriptor.styles[index].content;
      code = cssToJs(styleContent, removeQuery(req.url) + "-" + index);
      send(res, code, "js");
      return;
    }
    // 处理js部分
    let script = compileScript(descriptor);
    if (script) {
      let scriptContent = await parseBareImport(script.content, req.url);
      code += rewriteDefault(scriptContent, "__script");
    }
    // 处理模板
    if (descriptor.template) {
      let templateRequest = removeQuery(req.url) + `?type=template`;
      code += `\nimport { render as __render } from ${JSON.stringify(
        templateRequest
      )}`;
      code += `\n__script.render = __render`;
    }
    // 处理样式
    if (descriptor.styles) {
      descriptor.styles.forEach((s, i) => {
        const styleRequest = removeQuery(req.url) + `?type=style&index=${i}`;
        code += `\nimport ${JSON.stringify(styleRequest)}`;
      });
    }
    // 添加热更新标志
    code += `\n__script.__hmrId = ${JSON.stringify(removeQuery(req.url))}`;
    // 导出
    code += `\nexport default __script`;
    send(res, code, "js");
  },
};

// 创建WebSocket服务
const createWebSocket = () => {
  // 创建一个服务实例
  const wss = new WebSocket.Server({ noServer: true });// 不用额外创建http服务，直接使用我们自己创建的http服务

  server.on("upgrade", (req, socket, head) => {
    if (req.headers["sec-websocket-protocol"] === "vite-hmr") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));
  });

  const sendMsg = (payload) => {
    const stringified = JSON.stringify(payload, null, 2);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(stringified);
      }
    });
  };

  return {
    wss,
    sendMsg,
  };
};
const { wss, sendMsg } = createWebSocket();

// 创建模块依赖图
const importerMap = new Map();
const importeeMap = new Map();

// map -> key -> set，检查map中的某个key是否存在，没有则添加
const ensureMapEntry = (map, key) => {
  let entry = map.get(key);
  if (!entry) {
    entry = new Set();
    map.set(key, entry);
  }
  return entry;
};

// 创建文件监听服务
const createFileWatcher = () => {
  const watcher = chokidar.watch(basePath, {
    ignored: [/node_modules/, /\.git/],
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 10,
    },
  });
  return watcher;
};
const watcher = createFileWatcher();

// 缓存Vue单文件的解析结果
const vueCache = new LRUCache({
  max: 65535,
});

// 处理文件路径到url
const filePathToUrl = (file) => {
  return file.replace(/\\/g, "/").replace(/^\.\.\/test/g, "");
};

// 监听文件改变
watcher.on("change", (file) => {
  if (file.endsWith(".vue")) {
    handleVueReload(file);
  } else if (file.endsWith(".js")) {
    handleJsReload(file);
  }
});

// 处理Vue单文件的热更新
const handleVueReload = (file) => {
  file = filePathToUrl(file);
  console.log("Vue文件修改", file);
  // 获取上一次的解析结果
  const prevDescriptor = vueCache.get(file);
  // 从缓存中删除上一次的解析结果
  vueCache.del(file);
  if (!prevDescriptor) {
    return;
  }
  // 解析
  let vue = readFile(file);
  descriptor = parseVue(vue).descriptor;
  vueCache.set(file, descriptor);
  // 检查哪部分发生了改变
  const sendReload = () => {
    sendMsg({
      type: "vue-reload",
      path: file,
    });
  };
  const sendRerender = () => {
    sendMsg({
      type: "vue-rerender",
      path: file,
    });
  };
  // js部分发生了改变发送reload事件
  if (!isEqualBlock(descriptor.script, prevDescriptor.script)) {
    return sendReload();
  }
  // template改变了发送rerender事件
  if (!isEqualBlock(descriptor.template, prevDescriptor.template)) {
    return sendRerender();
  }
  // style部分发生了改变
  const prevStyles = prevDescriptor.styles || [];
  const nextStyles = descriptor.styles || [];
  nextStyles.forEach((_, i) => {
    if (!prevStyles[i] || !isEqualBlock(prevStyles[i], nextStyles[i])) {
      sendMsg({
        type: "style-update",
        path: `${file}?import&type=style&index=${i}`,
      });
    }
  });
  // 删除已经被删掉的样式块
  prevStyles.slice(nextStyles.length).forEach((_, i) => {
    sendMsg({
      type: "style-remove",
      path: file,
      id: `${file}-${i + nextStyles.length}`,
    });
  });
};

// 获取模块的直接依赖模块
const getImporters = (file) => {
  let importers = importerMap.get(file);
  if (!importers || importers.size <= 0) {
    importers = importerMap.get("." + file);
  }
  return importers;
};

// 处理js文件的热更新
const handleJsReload = (file) => {
  file = filePathToUrl(file);
  console.log("js文件修改", file, "." + file);
  // 因为构建依赖图的时候有些是以相对路径引用的，而监听获取到的都是绝对路径，所以稍微兼容一下
  let importers = getImporters(file);
  console.log(importers);
  // 遍历直接依赖
  if (importers && importers.size > 0) {
    // 需要进行热更新的模块
    const hmrBoundaries = new Set();
    // 递归依赖图获取要更新的模块
    const hasDeadEnd = walkImportChain(importers, hmrBoundaries);
    const boundaries = [...hmrBoundaries];
    console.log("hasDeadEnd", hasDeadEnd);
    console.log(JSON.stringify(boundaries));
    // 无法热更新，刷新这个页面
    if (hasDeadEnd) {
      sendMsg({
        type: "full-reload",
      });
    } else {
      // 可以热更新
      sendMsg({
        type: "multi", // 可能有多个模块，所以发送一个multi消息
        updates: boundaries.map((boundary) => {
          return {
            type: "vue-reload",
            path: boundary,
          };
        }),
      });
    }
  }
};

// 递归遍历依赖图
const walkImportChain = (importers, hmrBoundaries, currentChain = []) => {
  for (const importer of importers) {
    if (importer.endsWith(".vue")) {
      // 依赖是Vue单文件那么支持热更新，添加到热更新模块集合里
      hmrBoundaries.add(importer);
    } else {
      // 获取依赖模块的再上层用来模块
      let parentImpoters = getImporters(importer);
      if (!parentImpoters || parentImpoters.size <= 0) {
        // 如果没有上层依赖了，那么代表走到死胡同了
        return true;
      } else if (!currentChain.includes(importer)) {
        // 通过currentChain来存储已经遍历过的模块
        // 递归再上层的依赖
        if (
          walkImportChain(
            parentImpoters,
            hmrBoundaries,
            currentChain.concat(importer)
          )
        ) {
          return true;
        }
      }
    }
  }
  return false;
};

// 判断Vue单文件解析后的两个部分是否相同
function isEqualBlock(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.src && b.src && a.src === b.src) return true;
  if (a.content !== b.content) return false;
  const keysA = Object.keys(a.attrs);
  const keysB = Object.keys(b.attrs);
  if (keysA.length !== keysB.length) {
    return false;
  }
  return keysA.every((key) => a.attrs[key] === b.attrs[key]);
}

app.use(async function (req, res, next) {
  // console.log("请求进来:", req.url);
  // 提供html页面
  if (req.url === "/" || req.url === "/index.html") {
    intercepts.html(req, res);
  } else if (req.url === clientPublicPath) {
    // 提供client.js
    let js = fs.readFileSync(path.join(__dirname, "./client.js"), "utf-8");
    send(res, js, "js");
  } else if (/\.js\??[^.]*$/.test(req.url)) {
    // js请求
    let js = readFile(removeQuery(req.url));
    js = await parseBareImport(js, req.url);
    send(res, js, "js");
  } else if (/^\/@module\//.test(req.url)) {
    // 拦截/@module请求
    intercepts.module(req, res);
  } else if (/\.css\??[^.]*$/.test(req.url)) {
    // 拦截css请求
    intercepts.css(req, res);
  } else if (/\.vue\??[^.]*$/.test(req.url)) {
    // vue单文件
    intercepts.vue(req, res);
  } else if (isStaticAsset(req.url) && checkQueryExist(req.url, "import")) {
    // import导入的静态文件
    send(res, `export default ${JSON.stringify(removeQuery(req.url))}`, "js");
  } else {
    next();
  }
});

// 静态文件服务
app.use(serveStatic(path.join(basePath, "public")));
app.use(serveStatic(path.join(basePath)));

server.listen(3000);
