// vite-hmr代表自定义的协议字符串
const socket = new WebSocket("ws://localhost:3000", "vite-hmr");

socket.addEventListener("message", async ({ data }) => {
  const payload = JSON.parse(data);
  console.log(payload);
  if (payload.type === "multi") {
    payload.updates.forEach(handleMessage);
  } else {
    handleMessage(payload);
  }
});

// 回调id
let callbackId = 0;
// 记录回调
const callbackMap = new Map();
// 模块导入后调用的全局方法
window.onModuleCallback = (id, module) => {
  document.body.removeChild(document.getElementById("moduleLoad"));
  // 执行回调
  let callback = callbackMap.get(id);
  if (callback) {
    callback(module);
  }
};

// 加载模块
const loadModule = ({ url, callback }) => {
  // 保存回调
  let id = callbackId++;
  callbackMap.set(id, callback);
  // 创建一个模块类型的script
  let script = document.createElement("script");
  script.type = "module";
  script.id = "moduleLoad";
  script.innerHTML = `
        import * as module from '${url}'
        window.onModuleCallback(${id}, module)
    `;
  document.body.appendChild(script);
};

const handleMessage = (payload) => {
  switch (payload.type) {
    case "vue-reload":
      loadModule({
        url: payload.path + "?t=" + Date.now(),
        callback: (module) => {
          window.__VUE_HMR_RUNTIME__.reload(payload.path, module.default);
        },
      });
      break;
    case "vue-rerender":
      loadModule({
        url: payload.path + "?type=template&t=" + Date.now(),
        callback: (module) => {
          window.__VUE_HMR_RUNTIME__.rerender(payload.path, module.render);
        },
      });
      break;
    case "style-update":
      loadModule({
        url: payload.path + "&t=" + Date.now(),
      });
      break;
    case "style-remove":
      document.head.removeChild(document.getElementById(payload.id));
      break;
    case "full-reload":
      location.reload();
      break;
    case "js-update":
      loadModule({
        url: payload.path + "?t=" + Date.now(),
      });
      break;
  }
};
