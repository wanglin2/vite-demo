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

const app = connect();
const basePath = path.join("../test/");
const typeAlias = {
  js: "application/javascript",
  css: "text/css",
  html: "text/html",
  json: "application/json",
};

// 处理裸导入
const parseBareImport = async (js) => {
  await init;
  let parseResult = parseEsModule(js);
  let s = new MagicString(js);
  // 遍历导入语句
  parseResult[0].forEach((item) => {
    // 不是裸导入则替换
    if (item.n[0] !== "." && item.n[0] !== "/") {
      s.overwrite(item.s, item.e, `/@module/${item.n}?import`);
    } else {
      s.overwrite(item.s, item.e, `${item.n}?import`);
    }
  });
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
const cssToJs = (css) => {
  return `
    const insertStyle = (css) => {
        let el = document.createElement('style')
        el.setAttribute('type', 'text/css')
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
      cssRes = cssToJs(cssRes);
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
    let { descriptor } = parseVue(vue);
    // 处理模板请求
    if (getQuery(req.url, "type") === "template") {
      code = compileTemplate({
        source: descriptor.template.content,
      }).code;
      code = await parseBareImport(code);
      send(res, code, "js");
      return;
    }
    // 处理样式请求
    if (getQuery(req.url, "type") === "style") {
      let index = getQuery(req.url, "index");
      let styleContent = descriptor.styles[index].content;
      code = cssToJs(styleContent);
      send(res, code, "js");
      return;
    }
    // 处理js部分
    let script = compileScript(descriptor);
    if (script) {
      let scriptContent = await parseBareImport(script.content);
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
    // 导出
    code += `\nexport default __script`;
    send(res, code, "js");
  },
};

app.use(async function (req, res, next) {
  // 提供html页面
  if (req.url === "/index.html") {
    let html = readFile("index.html");
    send(res, html, "html");
  } else if (/\.js$/.test(req.url)) {
    // js请求
    let js = readFile(req.url);
    js = await parseBareImport(js);
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

http.createServer(app).listen(3000);
