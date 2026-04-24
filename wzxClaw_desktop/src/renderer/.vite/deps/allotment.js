import {
  require_react
} from "./chunk-T22SPHRE.js";
import {
  __toESM
} from "./chunk-DC5AMYBS.js";

// node_modules/allotment/dist/modern.mjs
var import_react = __toESM(require_react(), 1);
function _extends() {
  return _extends = Object.assign ? Object.assign.bind() : function(n2) {
    for (var e3 = 1; e3 < arguments.length; e3++) {
      var t2 = arguments[e3];
      for (var r2 in t2) ({}).hasOwnProperty.call(t2, r2) && (n2[r2] = t2[r2]);
    }
    return n2;
  }, _extends.apply(null, arguments);
}
var l = "undefined" != typeof globalThis ? globalThis : "undefined" != typeof window ? window : "undefined" != typeof global ? global : "undefined" != typeof self ? self : {};
function u(e3) {
  return e3 && e3.__esModule && Object.prototype.hasOwnProperty.call(e3, "default") ? e3.default : e3;
}
var c;
var m = {
  exports: {}
};
var d;
var f;
var p;
var v = (c || (c = 1, d = m, (function() {
  var e3 = {}.hasOwnProperty;
  function t2() {
    for (var e4 = "", t3 = 0; t3 < arguments.length; t3++) {
      var n2 = arguments[t3];
      n2 && (e4 = s2(e4, i2(n2)));
    }
    return e4;
  }
  function i2(i3) {
    if ("string" == typeof i3 || "number" == typeof i3) return i3;
    if ("object" != typeof i3) return "";
    if (Array.isArray(i3)) return t2.apply(null, i3);
    if (i3.toString !== Object.prototype.toString && !i3.toString.toString().includes("[native code]")) return i3.toString();
    var n2 = "";
    for (var r2 in i3) e3.call(i3, r2) && i3[r2] && (n2 = s2(n2, r2));
    return n2;
  }
  function s2(e4, t3) {
    return t3 ? e4 ? e4 + " " + t3 : e4 + t3 : e4;
  }
  d.exports ? (t2.default = t2, d.exports = t2) : window.classNames = t2;
})()), m.exports);
var S = u(v);
var z;
var w;
var g = (p || (p = 1, f = function e2(t2, i2) {
  if (t2 === i2) return true;
  if (t2 && i2 && "object" == typeof t2 && "object" == typeof i2) {
    if (t2.constructor !== i2.constructor) return false;
    var s2, n2, r2;
    if (Array.isArray(t2)) {
      if ((s2 = t2.length) != i2.length) return false;
      for (n2 = s2; 0 !== n2--; ) if (!e2(t2[n2], i2[n2])) return false;
      return true;
    }
    if (t2 instanceof Map && i2 instanceof Map) {
      if (t2.size !== i2.size) return false;
      for (n2 of t2.entries()) if (!i2.has(n2[0])) return false;
      for (n2 of t2.entries()) if (!e2(n2[1], i2.get(n2[0]))) return false;
      return true;
    }
    if (t2 instanceof Set && i2 instanceof Set) {
      if (t2.size !== i2.size) return false;
      for (n2 of t2.entries()) if (!i2.has(n2[0])) return false;
      return true;
    }
    if (ArrayBuffer.isView(t2) && ArrayBuffer.isView(i2)) {
      if ((s2 = t2.length) != i2.length) return false;
      for (n2 = s2; 0 !== n2--; ) if (t2[n2] !== i2[n2]) return false;
      return true;
    }
    if (t2.constructor === RegExp) return t2.source === i2.source && t2.flags === i2.flags;
    if (t2.valueOf !== Object.prototype.valueOf) return t2.valueOf() === i2.valueOf();
    if (t2.toString !== Object.prototype.toString) return t2.toString() === i2.toString();
    if ((s2 = (r2 = Object.keys(t2)).length) !== Object.keys(i2).length) return false;
    for (n2 = s2; 0 !== n2--; ) if (!Object.prototype.hasOwnProperty.call(i2, r2[n2])) return false;
    for (n2 = s2; 0 !== n2--; ) {
      var o2 = r2[n2];
      if (!e2(t2[o2], i2[o2])) return false;
    }
    return true;
  }
  return t2 != t2 && i2 != i2;
}), f);
var y = u(g);
var b;
var I;
var x = u((function() {
  if (w) return z;
  w = 1;
  var e3 = /^\s+|\s+$/g, t2 = /^[-+]0x[0-9a-f]+$/i, i2 = /^0b[01]+$/i, s2 = /^0o[0-7]+$/i, n2 = parseInt, r2 = Object.prototype.toString;
  function o2(e4) {
    var t3 = typeof e4;
    return !!e4 && ("object" == t3 || "function" == t3);
  }
  function a2(a3) {
    if ("number" == typeof a3) return a3;
    if ((function(e4) {
      return "symbol" == typeof e4 || /* @__PURE__ */ (function(e5) {
        return !!e5 && "object" == typeof e5;
      })(e4) && "[object Symbol]" == r2.call(e4);
    })(a3)) return NaN;
    if (o2(a3)) {
      var h2 = "function" == typeof a3.valueOf ? a3.valueOf() : a3;
      a3 = o2(h2) ? h2 + "" : h2;
    }
    if ("string" != typeof a3) return 0 === a3 ? a3 : +a3;
    a3 = a3.replace(e3, "");
    var l2 = i2.test(a3);
    return l2 || s2.test(a3) ? n2(a3.slice(2), l2 ? 2 : 8) : t2.test(a3) ? NaN : +a3;
  }
  return z = function(e4, t3, i3) {
    return void 0 === i3 && (i3 = t3, t3 = void 0), void 0 !== i3 && (i3 = (i3 = a2(i3)) == i3 ? i3 : 0), void 0 !== t3 && (t3 = (t3 = a2(t3)) == t3 ? t3 : 0), (function(e5, t4, i4) {
      return e5 == e5 && (void 0 !== i4 && (e5 = e5 <= i4 ? e5 : i4), void 0 !== t4 && (e5 = e5 >= t4 ? e5 : t4)), e5;
    })(a2(e4), t3, i3);
  };
})());
var _ = u((function() {
  if (I) return b;
  I = 1;
  var e3 = /^\s+|\s+$/g, t2 = /^[-+]0x[0-9a-f]+$/i, i2 = /^0b[01]+$/i, s2 = /^0o[0-7]+$/i, n2 = parseInt, r2 = "object" == typeof l && l && l.Object === Object && l, o2 = "object" == typeof self && self && self.Object === Object && self, a2 = r2 || o2 || Function("return this")(), h2 = Object.prototype.toString, u2 = Math.max, c2 = Math.min, m2 = function m3() {
    return a2.Date.now();
  };
  function d2(e4) {
    var t3 = typeof e4;
    return !!e4 && ("object" == t3 || "function" == t3);
  }
  function f2(r3) {
    if ("number" == typeof r3) return r3;
    if ((function(e4) {
      return "symbol" == typeof e4 || /* @__PURE__ */ (function(e5) {
        return !!e5 && "object" == typeof e5;
      })(e4) && "[object Symbol]" == h2.call(e4);
    })(r3)) return NaN;
    if (d2(r3)) {
      var o3 = "function" == typeof r3.valueOf ? r3.valueOf() : r3;
      r3 = d2(o3) ? o3 + "" : o3;
    }
    if ("string" != typeof r3) return 0 === r3 ? r3 : +r3;
    r3 = r3.replace(e3, "");
    var a3 = i2.test(r3);
    return a3 || s2.test(r3) ? n2(r3.slice(2), a3 ? 2 : 8) : t2.test(r3) ? NaN : +r3;
  }
  return b = function(e4, t3, i3) {
    var s3, n3, r3, o3, a3, h3, l2 = 0, p2 = false, v2 = false, S2 = true;
    if ("function" != typeof e4) throw new TypeError("Expected a function");
    function z2(t4) {
      var i4 = s3, r4 = n3;
      return s3 = n3 = void 0, l2 = t4, o3 = e4.apply(r4, i4);
    }
    function w2(e5) {
      var i4 = e5 - h3;
      return void 0 === h3 || i4 >= t3 || i4 < 0 || v2 && e5 - l2 >= r3;
    }
    function g2() {
      var e5 = m2();
      if (w2(e5)) return y2(e5);
      a3 = setTimeout(g2, (function(e6) {
        var i4 = t3 - (e6 - h3);
        return v2 ? c2(i4, r3 - (e6 - l2)) : i4;
      })(e5));
    }
    function y2(e5) {
      return a3 = void 0, S2 && s3 ? z2(e5) : (s3 = n3 = void 0, o3);
    }
    function b2() {
      var e5 = m2(), i4 = w2(e5);
      if (s3 = arguments, n3 = this, h3 = e5, i4) {
        if (void 0 === a3) return (function(e6) {
          return l2 = e6, a3 = setTimeout(g2, t3), p2 ? z2(e6) : o3;
        })(h3);
        if (v2) return a3 = setTimeout(g2, t3), z2(h3);
      }
      return void 0 === a3 && (a3 = setTimeout(g2, t3)), o3;
    }
    return t3 = f2(t3) || 0, d2(i3) && (p2 = !!i3.leading, r3 = (v2 = "maxWait" in i3) ? u2(f2(i3.maxWait) || 0, t3) : r3, S2 = "trailing" in i3 ? !!i3.trailing : S2), b2.cancel = function() {
      void 0 !== a3 && clearTimeout(a3), l2 = 0, s3 = h3 = n3 = a3 = void 0;
    }, b2.flush = function() {
      return void 0 === a3 ? o3 : y2(m2());
    }, b2;
  };
})());
var V = {
  width: void 0,
  height: void 0
};
function E(e3) {
  const {
    ref: r2,
    box: o2 = "content-box"
  } = e3, [{
    width: a2,
    height: h2
  }, l2] = (0, import_react.useState)(V), u2 = (function() {
    const e4 = (0, import_react.useRef)(false);
    return (0, import_react.useEffect)(() => (e4.current = true, () => {
      e4.current = false;
    }), []), (0, import_react.useCallback)(() => e4.current, []);
  })(), c2 = (0, import_react.useRef)(_extends({}, V)), m2 = (0, import_react.useRef)(void 0);
  return m2.current = e3.onResize, (0, import_react.useEffect)(() => {
    if (!r2.current) return;
    if ("undefined" == typeof window || !("ResizeObserver" in window)) return;
    const e4 = new ResizeObserver(([e5]) => {
      const t2 = "border-box" === o2 ? "borderBoxSize" : "device-pixel-content-box" === o2 ? "devicePixelContentBoxSize" : "contentBoxSize", i2 = N(e5, t2, "inlineSize"), s2 = N(e5, t2, "blockSize");
      if (c2.current.width !== i2 || c2.current.height !== s2) {
        const _e2 = {
          width: i2,
          height: s2
        };
        c2.current.width = i2, c2.current.height = s2, m2.current ? m2.current(_e2) : u2() && l2(_e2);
      }
    });
    return e4.observe(r2.current, {
      box: o2
    }), () => {
      e4.disconnect();
    };
  }, [o2, r2, u2]), {
    width: a2,
    height: h2
  };
}
function N(e3, t2, i2) {
  return e3[t2] ? Array.isArray(e3[t2]) ? e3[t2][0][i2] : e3[t2][i2] : "contentBoxSize" === t2 ? e3.contentRect["inlineSize" === i2 ? "width" : "height"] : void 0;
}
var L = "allotment-module_splitView__L-yRc";
var D = "allotment-module_sashContainer__fzwJF";
var O = "allotment-module_splitViewContainer__rQnVa";
var M = "allotment-module_splitViewView__MGZ6O";
var P = "allotment-module_vertical__WSwwa";
var T = "allotment-module_horizontal__7doS8";
var C = "allotment-module_separatorBorder__x-rDS";
var A;
var j = false;
var F = false;
"object" == typeof navigator && (A = navigator.userAgent, F = A.indexOf("Macintosh") >= 0, j = (A.indexOf("Macintosh") >= 0 || A.indexOf("iPad") >= 0 || A.indexOf("iPhone") >= 0) && !!navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
var H = j;
var Y = F;
var k = "undefined" != typeof window && void 0 !== window.document && void 0 !== window.document.createElement ? import_react.useLayoutEffect : import_react.useEffect;
var $ = class {
  constructor() {
    this._size = void 0;
  }
  getSize() {
    return this._size;
  }
  setSize(e3) {
    this._size = e3;
  }
};
function B(e3, t2) {
  const i2 = e3.length, s2 = i2 - t2.length;
  return s2 >= 0 && e3.slice(s2, i2) === t2;
}
var R;
var W = {
  exports: {}
};
var X = (R || (R = 1, (function(e3) {
  var t2 = Object.prototype.hasOwnProperty, i2 = "~";
  function s2() {
  }
  function n2(e4, t3, i3) {
    this.fn = e4, this.context = t3, this.once = i3 || false;
  }
  function r2(e4, t3, s3, r3, o3) {
    if ("function" != typeof s3) throw new TypeError("The listener must be a function");
    var a3 = new n2(s3, r3 || e4, o3), h2 = i2 ? i2 + t3 : t3;
    return e4._events[h2] ? e4._events[h2].fn ? e4._events[h2] = [e4._events[h2], a3] : e4._events[h2].push(a3) : (e4._events[h2] = a3, e4._eventsCount++), e4;
  }
  function o2(e4, t3) {
    0 === --e4._eventsCount ? e4._events = new s2() : delete e4._events[t3];
  }
  function a2() {
    this._events = new s2(), this._eventsCount = 0;
  }
  Object.create && (s2.prototype = /* @__PURE__ */ Object.create(null), new s2().__proto__ || (i2 = false)), a2.prototype.eventNames = function() {
    var e4, s3, n3 = [];
    if (0 === this._eventsCount) return n3;
    for (s3 in e4 = this._events) t2.call(e4, s3) && n3.push(i2 ? s3.slice(1) : s3);
    return Object.getOwnPropertySymbols ? n3.concat(Object.getOwnPropertySymbols(e4)) : n3;
  }, a2.prototype.listeners = function(e4) {
    var t3 = i2 ? i2 + e4 : e4, s3 = this._events[t3];
    if (!s3) return [];
    if (s3.fn) return [s3.fn];
    for (var n3 = 0, r3 = s3.length, o3 = new Array(r3); n3 < r3; n3++) o3[n3] = s3[n3].fn;
    return o3;
  }, a2.prototype.listenerCount = function(e4) {
    var t3 = i2 ? i2 + e4 : e4, s3 = this._events[t3];
    return s3 ? s3.fn ? 1 : s3.length : 0;
  }, a2.prototype.emit = function(e4, t3, s3, n3, r3, o3) {
    var a3 = i2 ? i2 + e4 : e4;
    if (!this._events[a3]) return false;
    var h2, l2, u2 = this._events[a3], c2 = arguments.length;
    if (u2.fn) {
      switch (u2.once && this.removeListener(e4, u2.fn, void 0, true), c2) {
        case 1:
          return u2.fn.call(u2.context), true;
        case 2:
          return u2.fn.call(u2.context, t3), true;
        case 3:
          return u2.fn.call(u2.context, t3, s3), true;
        case 4:
          return u2.fn.call(u2.context, t3, s3, n3), true;
        case 5:
          return u2.fn.call(u2.context, t3, s3, n3, r3), true;
        case 6:
          return u2.fn.call(u2.context, t3, s3, n3, r3, o3), true;
      }
      for (l2 = 1, h2 = new Array(c2 - 1); l2 < c2; l2++) h2[l2 - 1] = arguments[l2];
      u2.fn.apply(u2.context, h2);
    } else {
      var m2, d2 = u2.length;
      for (l2 = 0; l2 < d2; l2++) switch (u2[l2].once && this.removeListener(e4, u2[l2].fn, void 0, true), c2) {
        case 1:
          u2[l2].fn.call(u2[l2].context);
          break;
        case 2:
          u2[l2].fn.call(u2[l2].context, t3);
          break;
        case 3:
          u2[l2].fn.call(u2[l2].context, t3, s3);
          break;
        case 4:
          u2[l2].fn.call(u2[l2].context, t3, s3, n3);
          break;
        default:
          if (!h2) for (m2 = 1, h2 = new Array(c2 - 1); m2 < c2; m2++) h2[m2 - 1] = arguments[m2];
          u2[l2].fn.apply(u2[l2].context, h2);
      }
    }
    return true;
  }, a2.prototype.on = function(e4, t3, i3) {
    return r2(this, e4, t3, i3, false);
  }, a2.prototype.once = function(e4, t3, i3) {
    return r2(this, e4, t3, i3, true);
  }, a2.prototype.removeListener = function(e4, t3, s3, n3) {
    var r3 = i2 ? i2 + e4 : e4;
    if (!this._events[r3]) return this;
    if (!t3) return o2(this, r3), this;
    var a3 = this._events[r3];
    if (a3.fn) a3.fn !== t3 || n3 && !a3.once || s3 && a3.context !== s3 || o2(this, r3);
    else {
      for (var h2 = 0, l2 = [], u2 = a3.length; h2 < u2; h2++) (a3[h2].fn !== t3 || n3 && !a3[h2].once || s3 && a3[h2].context !== s3) && l2.push(a3[h2]);
      l2.length ? this._events[r3] = 1 === l2.length ? l2[0] : l2 : o2(this, r3);
    }
    return this;
  }, a2.prototype.removeAllListeners = function(e4) {
    var t3;
    return e4 ? (t3 = i2 ? i2 + e4 : e4, this._events[t3] && o2(this, t3)) : (this._events = new s2(), this._eventsCount = 0), this;
  }, a2.prototype.off = a2.prototype.removeListener, a2.prototype.addListener = a2.prototype.on, a2.prefixed = i2, a2.EventEmitter = a2, e3.exports = a2;
})(W)), W.exports);
var G = u(X);
function J(e3, t2) {
  const i2 = e3.indexOf(t2);
  i2 > -1 && (e3.splice(i2, 1), e3.unshift(t2));
}
function U(e3, t2) {
  const i2 = e3.indexOf(t2);
  i2 > -1 && (e3.splice(i2, 1), e3.push(t2));
}
function K(e3, t2, i2 = 1) {
  const s2 = Math.max(0, Math.ceil((t2 - e3) / i2)), n2 = new Array(s2);
  let r2 = -1;
  for (; ++r2 < s2; ) n2[r2] = e3 + r2 * i2;
  return n2;
}
var Z = "sash-module_sash__K-9lB";
var Q = "sash-module_disabled__Hm-wx";
var q = "sash-module_mac__Jf6OJ";
var ee = "sash-module_vertical__pB-rs";
var te = "sash-module_minimum__-UKxp";
var ie = "sash-module_maximum__TCWxD";
var se = "sash-module_horizontal__kFbiw";
var ne = "sash-module_hover__80W6I";
var re = "sash-module_active__bJspD";
var oe = (function(e3) {
  return e3.Vertical = "VERTICAL", e3.Horizontal = "HORIZONTAL", e3;
})({});
var ae = (function(e3) {
  return e3.Disabled = "DISABLED", e3.Minimum = "MINIMUM", e3.Maximum = "MAXIMUM", e3.Enabled = "ENABLED", e3;
})({});
var he = H ? 20 : 8;
var le = new G();
var ue = class extends G {
  get state() {
    return this._state;
  }
  set state(e3) {
    this._state !== e3 && (this.el.classList.toggle(Q, e3 === ae.Disabled), this.el.classList.toggle("sash-disabled", e3 === ae.Disabled), this.el.classList.toggle(te, e3 === ae.Minimum), this.el.classList.toggle("sash-minimum", e3 === ae.Minimum), this.el.classList.toggle(ie, e3 === ae.Maximum), this.el.classList.toggle("sash-maximum", e3 === ae.Maximum), this._state = e3, this.emit("enablementChange", e3));
  }
  constructor(e3, t2, i2) {
    var _i$orientation;
    super(), this.el = void 0, this.layoutProvider = void 0, this.orientation = void 0, this.size = void 0, this.hoverDelay = 300, this.hoverDelayer = _((e4) => e4.classList.add("sash-hover", ne), this.hoverDelay), this._state = ae.Enabled, this.onPointerStart = (e4) => {
      const t3 = e4.pageX, i3 = e4.pageY, s2 = {
        startX: t3,
        currentX: t3,
        startY: i3,
        currentY: i3
      };
      this.el.classList.add("sash-active", re), this.emit("start", s2), this.el.setPointerCapture(e4.pointerId);
      const n2 = (e5) => {
        e5.preventDefault();
        const s3 = {
          startX: t3,
          currentX: e5.pageX,
          startY: i3,
          currentY: e5.pageY
        };
        this.emit("change", s3);
      }, r2 = (e5) => {
        e5.preventDefault(), this.el.classList.remove("sash-active", re), this.hoverDelayer.cancel(), this.emit("end"), this.el.releasePointerCapture(e5.pointerId), window.removeEventListener("pointermove", n2), window.removeEventListener("pointerup", r2);
      };
      window.addEventListener("pointermove", n2), window.addEventListener("pointerup", r2);
    }, this.onPointerDoublePress = () => {
      this.emit("reset");
    }, this.onMouseEnter = () => {
      this.el.classList.contains(re) ? (this.hoverDelayer.cancel(), this.el.classList.add("sash-hover", ne)) : this.hoverDelayer(this.el);
    }, this.onMouseLeave = () => {
      this.hoverDelayer.cancel(), this.el.classList.remove("sash-hover", ne);
    }, this.el = document.createElement("div"), this.el.classList.add("sash", Z), this.el.dataset.testid = "sash", e3.append(this.el), Y && this.el.classList.add("sash-mac", q), this.el.addEventListener("pointerdown", this.onPointerStart), this.el.addEventListener("dblclick", this.onPointerDoublePress), this.el.addEventListener("mouseenter", this.onMouseEnter), this.el.addEventListener("mouseleave", this.onMouseLeave), "number" == typeof i2.size ? (this.size = i2.size, i2.orientation === oe.Vertical ? this.el.style.width = `${this.size}px` : this.el.style.height = `${this.size}px`) : (this.size = he, le.on("onDidChangeGlobalSize", (e4) => {
      this.size = e4, this.layout();
    })), this.layoutProvider = t2, this.orientation = (_i$orientation = i2.orientation) != null ? _i$orientation : oe.Vertical, this.orientation === oe.Horizontal ? (this.el.classList.add("sash-horizontal", se), this.el.classList.remove("sash-vertical", ee)) : (this.el.classList.remove("sash-horizontal", se), this.el.classList.add("sash-vertical", ee)), this.layout();
  }
  layout() {
    if (this.orientation === oe.Vertical) {
      const e3 = this.layoutProvider;
      this.el.style.left = e3.getVerticalSashLeft(this) - this.size / 2 + "px", e3.getVerticalSashTop && (this.el.style.top = e3.getVerticalSashTop(this) + "px"), e3.getVerticalSashHeight && (this.el.style.height = e3.getVerticalSashHeight(this) + "px");
    } else {
      const e3 = this.layoutProvider;
      this.el.style.top = e3.getHorizontalSashTop(this) - this.size / 2 + "px", e3.getHorizontalSashLeft && (this.el.style.left = e3.getHorizontalSashLeft(this) + "px"), e3.getHorizontalSashWidth && (this.el.style.width = e3.getHorizontalSashWidth(this) + "px");
    }
  }
  dispose() {
    this.el.removeEventListener("pointerdown", this.onPointerStart), this.el.removeEventListener("dblclick", this.onPointerDoublePress), this.el.removeEventListener("mouseenter", this.onMouseEnter), this.el.removeEventListener("mouseleave", () => this.onMouseLeave), this.el.remove();
  }
};
var ce;
var me;
(me = ce || (ce = {})).Distribute = {
  type: "distribute"
}, me.Split = function(e3) {
  return {
    type: "split",
    index: e3
  };
}, me.Invisible = function(e3) {
  return {
    type: "invisible",
    cachedVisibleSize: e3
  };
};
var de = (function(e3) {
  return e3.Normal = "NORMAL", e3.Low = "LOW", e3.High = "HIGH", e3;
})({});
var fe = class {
  constructor(e3, t2, i2) {
    this.container = void 0, this.view = void 0, this._size = void 0, this._cachedVisibleSize = void 0, this.container = e3, this.view = t2, this.container.classList.add("split-view-view", M), this.container.dataset.testid = "split-view-view", "number" == typeof i2 ? (this._size = i2, this._cachedVisibleSize = void 0, e3.classList.add("split-view-view-visible")) : (this._size = 0, this._cachedVisibleSize = i2.cachedVisibleSize);
  }
  set size(e3) {
    this._size = e3;
  }
  get size() {
    return this._size;
  }
  get priority() {
    return this.view.priority;
  }
  get snap() {
    return !!this.view.snap;
  }
  get cachedVisibleSize() {
    return this._cachedVisibleSize;
  }
  get visible() {
    return void 0 === this._cachedVisibleSize;
  }
  setVisible(e3, t2) {
    e3 !== this.visible && (e3 ? (this.size = x(this._cachedVisibleSize, this.viewMinimumSize, this.viewMaximumSize), this._cachedVisibleSize = void 0) : (this._cachedVisibleSize = "number" == typeof t2 ? t2 : this.size, this.size = 0), this.container.classList.toggle("split-view-view-visible", e3), this.view.setVisible && this.view.setVisible(e3));
  }
  get minimumSize() {
    return this.visible ? this.view.minimumSize : 0;
  }
  get viewMinimumSize() {
    return this.view.minimumSize;
  }
  get maximumSize() {
    return this.visible ? this.view.maximumSize : 0;
  }
  get viewMaximumSize() {
    return this.view.maximumSize;
  }
  set enabled(e3) {
    this.container.style.pointerEvents = e3 ? "" : "none";
  }
  layout(e3) {
    this.layoutContainer(e3), this.view.layout(this.size, e3);
  }
};
var pe = class extends fe {
  layoutContainer(e3) {
    this.container.style.left = `${e3}px`, this.container.style.width = `${this.size}px`;
  }
};
var ve = class extends fe {
  layoutContainer(e3) {
    this.container.style.top = `${e3}px`, this.container.style.height = `${this.size}px`;
  }
};
var Se = class extends G {
  get startSnappingEnabled() {
    return this._startSnappingEnabled;
  }
  set startSnappingEnabled(e3) {
    this._startSnappingEnabled !== e3 && (this._startSnappingEnabled = e3, this.updateSashEnablement());
  }
  get endSnappingEnabled() {
    return this._endSnappingEnabled;
  }
  set endSnappingEnabled(e3) {
    this._endSnappingEnabled !== e3 && (this._endSnappingEnabled = e3, this.updateSashEnablement());
  }
  constructor(e3, t2 = {}, i2, s2, n2) {
    var _t$orientation, _t$proportionalLayout;
    if (super(), this.onDidChange = void 0, this.onDidDragStart = void 0, this.onDidDragEnd = void 0, this.orientation = void 0, this.sashContainer = void 0, this.size = 0, this.contentSize = 0, this.proportions = void 0, this.viewItems = [], this.sashItems = [], this.sashDragState = void 0, this.proportionalLayout = void 0, this.getSashOrthogonalSize = void 0, this._startSnappingEnabled = true, this._endSnappingEnabled = true, this.onSashEnd = (e4) => {
      this.emit("sashchange", e4), this.saveProportions();
      for (const _e3 of this.viewItems) _e3.enabled = true;
    }, this.orientation = (_t$orientation = t2.orientation) != null ? _t$orientation : oe.Vertical, this.proportionalLayout = (_t$proportionalLayout = t2.proportionalLayout) != null ? _t$proportionalLayout : true, this.getSashOrthogonalSize = t2.getSashOrthogonalSize, i2 && (this.onDidChange = i2), s2 && (this.onDidDragStart = s2), n2 && (this.onDidDragEnd = n2), this.sashContainer = document.createElement("div"), this.sashContainer.classList.add("sash-container", D), e3.prepend(this.sashContainer), t2.descriptor) {
      this.size = t2.descriptor.size;
      for (const [_e4, _i] of t2.descriptor.views.entries()) {
        const _t = _i.size, _s = _i.container, _n = _i.view;
        this.addView(_s, _n, _t, _e4, true);
      }
      this.contentSize = this.viewItems.reduce((e4, t3) => e4 + t3.size, 0), this.saveProportions();
    }
  }
  addView(e3, t2, i2, s2 = this.viewItems.length, n2) {
    let r2;
    r2 = "number" == typeof i2 ? i2 : "split" === i2.type ? this.getViewSize(i2.index) / 2 : "invisible" === i2.type ? {
      cachedVisibleSize: i2.cachedVisibleSize
    } : t2.minimumSize;
    const o2 = this.orientation === oe.Vertical ? new ve(e3, t2, r2) : new pe(e3, t2, r2);
    if (this.viewItems.splice(s2, 0, o2), this.viewItems.length > 1) {
      const _e5 = this.orientation === oe.Vertical ? new ue(this.sashContainer, {
        getHorizontalSashTop: (e4) => this.getSashPosition(e4),
        getHorizontalSashWidth: this.getSashOrthogonalSize
      }, {
        orientation: oe.Horizontal
      }) : new ue(this.sashContainer, {
        getVerticalSashLeft: (e4) => this.getSashPosition(e4),
        getVerticalSashHeight: this.getSashOrthogonalSize
      }, {
        orientation: oe.Vertical
      }), _t2 = this.orientation === oe.Vertical ? (t3) => ({
        sash: _e5,
        start: t3.startY,
        current: t3.currentY
      }) : (t3) => ({
        sash: _e5,
        start: t3.startX,
        current: t3.currentX
      });
      _e5.on("start", (e4) => {
        var _this$onDidDragStart;
        this.emit("sashDragStart"), this.onSashStart(_t2(e4));
        const i3 = this.viewItems.map((e5) => e5.size);
        (_this$onDidDragStart = this.onDidDragStart) == null || _this$onDidDragStart.call(this, i3);
      }), _e5.on("change", (e4) => this.onSashChange(_t2(e4))), _e5.on("end", () => {
        var _this$onDidDragEnd;
        this.emit("sashDragEnd"), this.onSashEnd(this.sashItems.findIndex((t4) => t4.sash === _e5));
        const t3 = this.viewItems.map((e4) => e4.size);
        (_this$onDidDragEnd = this.onDidDragEnd) == null || _this$onDidDragEnd.call(this, t3);
      }), _e5.on("reset", () => {
        const t3 = this.sashItems.findIndex((t4) => t4.sash === _e5), i3 = K(t3, -1, -1), s3 = K(t3 + 1, this.viewItems.length), n3 = this.findFirstSnapIndex(i3), r3 = this.findFirstSnapIndex(s3);
        ("number" != typeof n3 || this.viewItems[n3].visible) && ("number" != typeof r3 || this.viewItems[r3].visible) && this.emit("sashreset", t3);
      });
      const _i2 = {
        sash: _e5
      };
      this.sashItems.splice(s2 - 1, 0, _i2);
    }
    n2 || this.relayout(), n2 || "number" == typeof i2 || "distribute" !== i2.type || this.distributeViewSizes();
  }
  removeView(e3, t2) {
    if (e3 < 0 || e3 >= this.viewItems.length) throw new Error("Index out of bounds");
    const i2 = this.viewItems.splice(e3, 1)[0].view;
    if (this.viewItems.length >= 1) {
      const _t3 = Math.max(e3 - 1, 0);
      this.sashItems.splice(_t3, 1)[0].sash.dispose();
    }
    return this.relayout(), t2 && "distribute" === t2.type && this.distributeViewSizes(), i2;
  }
  moveView(e3, t2, i2) {
    const s2 = this.getViewCachedVisibleSize(t2), n2 = void 0 === s2 ? this.getViewSize(t2) : ce.Invisible(s2), r2 = this.removeView(t2);
    this.addView(e3, r2, n2, i2);
  }
  getViewCachedVisibleSize(e3) {
    if (e3 < 0 || e3 >= this.viewItems.length) throw new Error("Index out of bounds");
    return this.viewItems[e3].cachedVisibleSize;
  }
  layout(e3 = this.size) {
    const t2 = Math.max(this.size, this.contentSize);
    if (this.size = e3, this.proportions) for (let _t4 = 0; _t4 < this.viewItems.length; _t4++) {
      const i2 = this.viewItems[_t4];
      i2.size = x(Math.round(this.proportions[_t4] * e3), i2.minimumSize, i2.maximumSize);
    }
    else {
      const i2 = K(0, this.viewItems.length), s2 = i2.filter((e4) => this.viewItems[e4].priority === de.Low), n2 = i2.filter((e4) => this.viewItems[e4].priority === de.High);
      this.resize(this.viewItems.length - 1, e3 - t2, void 0, s2, n2);
    }
    this.distributeEmptySpace(), this.layoutViews();
  }
  resizeView(e3, t2) {
    if (e3 < 0 || e3 >= this.viewItems.length) return;
    const i2 = K(0, this.viewItems.length).filter((t3) => t3 !== e3), s2 = [...i2.filter((e4) => this.viewItems[e4].priority === de.Low), e3], n2 = i2.filter((e4) => this.viewItems[e4].priority === de.High), r2 = this.viewItems[e3];
    t2 = Math.round(t2), t2 = x(t2, r2.minimumSize, Math.min(r2.maximumSize, this.size)), r2.size = t2, this.relayout(s2, n2);
  }
  resizeViews(e3) {
    for (let t2 = 0; t2 < e3.length; t2++) {
      const i2 = this.viewItems[t2];
      let s2 = e3[t2];
      s2 = Math.round(s2), s2 = x(s2, i2.minimumSize, Math.min(i2.maximumSize, this.size)), i2.size = s2;
    }
    this.contentSize = this.viewItems.reduce((e4, t2) => e4 + t2.size, 0), this.saveProportions(), this.layout(this.size);
  }
  getViewSize(e3) {
    return e3 < 0 || e3 >= this.viewItems.length ? -1 : this.viewItems[e3].size;
  }
  isViewVisible(e3) {
    if (e3 < 0 || e3 >= this.viewItems.length) throw new Error("Index out of bounds");
    return this.viewItems[e3].visible;
  }
  setViewVisible(e3, t2) {
    if (e3 < 0 || e3 >= this.viewItems.length) throw new Error("Index out of bounds");
    this.viewItems[e3].setVisible(t2), this.distributeEmptySpace(e3), this.layoutViews(), this.saveProportions();
  }
  distributeViewSizes() {
    const e3 = [];
    let t2 = 0;
    for (const _i3 of this.viewItems) _i3.maximumSize - _i3.minimumSize > 0 && (e3.push(_i3), t2 += _i3.size);
    const i2 = Math.floor(t2 / e3.length);
    for (const _t5 of e3) _t5.size = x(i2, _t5.minimumSize, _t5.maximumSize);
    const s2 = K(0, this.viewItems.length), n2 = s2.filter((e4) => this.viewItems[e4].priority === de.Low), r2 = s2.filter((e4) => this.viewItems[e4].priority === de.High);
    this.relayout(n2, r2);
  }
  dispose() {
    this.sashItems.forEach((e3) => e3.sash.dispose()), this.sashItems = [], this.sashContainer.remove();
  }
  relayout(e3, t2) {
    const i2 = this.viewItems.reduce((e4, t3) => e4 + t3.size, 0);
    this.resize(this.viewItems.length - 1, this.size - i2, void 0, e3, t2), this.distributeEmptySpace(), this.layoutViews(), this.saveProportions();
  }
  onSashStart({
    sash: e3,
    start: t2
  }) {
    const i2 = this.sashItems.findIndex((t3) => t3.sash === e3);
    ((e4) => {
      const t3 = this.viewItems.map((e5) => e5.size);
      let s2, n2, r2 = Number.NEGATIVE_INFINITY, o2 = Number.POSITIVE_INFINITY;
      const a2 = K(i2, -1, -1), h2 = K(i2 + 1, this.viewItems.length), l2 = a2.reduce((e5, i3) => e5 + (this.viewItems[i3].minimumSize - t3[i3]), 0), u2 = a2.reduce((e5, i3) => e5 + (this.viewItems[i3].viewMaximumSize - t3[i3]), 0), c2 = 0 === h2.length ? Number.POSITIVE_INFINITY : h2.reduce((e5, i3) => e5 + (t3[i3] - this.viewItems[i3].minimumSize), 0), m2 = 0 === h2.length ? Number.NEGATIVE_INFINITY : h2.reduce((e5, i3) => e5 + (t3[i3] - this.viewItems[i3].viewMaximumSize), 0);
      r2 = Math.max(l2, m2), o2 = Math.min(c2, u2);
      const d2 = this.findFirstSnapIndex(a2), f2 = this.findFirstSnapIndex(h2);
      if ("number" == typeof d2) {
        const _e6 = this.viewItems[d2], _t6 = Math.floor(_e6.viewMinimumSize / 2);
        s2 = {
          index: d2,
          limitDelta: _e6.visible ? r2 - _t6 : r2 + _t6,
          size: _e6.size
        };
      }
      if ("number" == typeof f2) {
        const _e7 = this.viewItems[f2], _t7 = Math.floor(_e7.viewMinimumSize / 2);
        n2 = {
          index: f2,
          limitDelta: _e7.visible ? o2 + _t7 : o2 - _t7,
          size: _e7.size
        };
      }
      this.sashDragState = {
        start: e4,
        current: e4,
        index: i2,
        sizes: t3,
        minDelta: r2,
        maxDelta: o2,
        snapBefore: s2,
        snapAfter: n2
      };
    })(t2);
  }
  onSashChange({
    current: e3
  }) {
    const {
      index: t2,
      start: i2,
      sizes: s2,
      minDelta: n2,
      maxDelta: r2,
      snapBefore: o2,
      snapAfter: a2
    } = this.sashDragState;
    this.sashDragState.current = e3;
    const h2 = e3 - i2;
    this.resize(t2, h2, s2, void 0, void 0, n2, r2, o2, a2), this.distributeEmptySpace(), this.layoutViews();
  }
  getSashPosition(e3) {
    let t2 = 0;
    for (let i2 = 0; i2 < this.sashItems.length; i2++) if (t2 += this.viewItems[i2].size, this.sashItems[i2].sash === e3) return t2;
    return 0;
  }
  resize(e3, t2, i2 = this.viewItems.map((e4) => e4.size), s2, n2, r2 = Number.NEGATIVE_INFINITY, o2 = Number.POSITIVE_INFINITY, a2, h2) {
    if (e3 < 0 || e3 >= this.viewItems.length) return 0;
    const l2 = K(e3, -1, -1), u2 = K(e3 + 1, this.viewItems.length);
    if (n2) for (const _e8 of n2) J(l2, _e8), J(u2, _e8);
    if (s2) for (const _e9 of s2) U(l2, _e9), U(u2, _e9);
    const c2 = l2.map((e4) => this.viewItems[e4]), m2 = l2.map((e4) => i2[e4]), d2 = u2.map((e4) => this.viewItems[e4]), f2 = u2.map((e4) => i2[e4]), p2 = l2.reduce((e4, t3) => e4 + (this.viewItems[t3].minimumSize - i2[t3]), 0), v2 = l2.reduce((e4, t3) => e4 + (this.viewItems[t3].maximumSize - i2[t3]), 0), S2 = 0 === u2.length ? Number.POSITIVE_INFINITY : u2.reduce((e4, t3) => e4 + (i2[t3] - this.viewItems[t3].minimumSize), 0), z2 = 0 === u2.length ? Number.NEGATIVE_INFINITY : u2.reduce((e4, t3) => e4 + (i2[t3] - this.viewItems[t3].maximumSize), 0), w2 = Math.max(p2, z2, r2), g2 = Math.min(S2, v2, o2);
    let y2 = false;
    if (a2) {
      const _e0 = this.viewItems[a2.index], _i4 = t2 >= a2.limitDelta;
      y2 = _i4 !== _e0.visible, _e0.setVisible(_i4, a2.size);
    }
    if (!y2 && h2) {
      const _e1 = this.viewItems[h2.index], _i5 = t2 < h2.limitDelta;
      y2 = _i5 !== _e1.visible, _e1.setVisible(_i5, h2.size);
    }
    if (y2) return this.resize(e3, t2, i2, s2, n2, r2, o2);
    for (let _e10 = 0, _i6 = t2 = x(t2, w2, g2); _e10 < c2.length; _e10++) {
      const _t8 = c2[_e10], _s2 = x(m2[_e10] + _i6, _t8.minimumSize, _t8.maximumSize);
      _i6 -= _s2 - m2[_e10], _t8.size = _s2;
    }
    for (let _e11 = 0, _i7 = t2; _e11 < d2.length; _e11++) {
      const _t9 = d2[_e11], _s3 = x(f2[_e11] - _i7, _t9.minimumSize, _t9.maximumSize);
      _i7 += _s3 - f2[_e11], _t9.size = _s3;
    }
    return t2;
  }
  distributeEmptySpace(e3) {
    const t2 = this.viewItems.reduce((e4, t3) => e4 + t3.size, 0);
    let i2 = this.size - t2;
    const s2 = K(0, this.viewItems.length), n2 = [], r2 = s2.filter((e4) => this.viewItems[e4].priority === de.Low), o2 = s2.filter((e4) => this.viewItems[e4].priority === de.Normal), a2 = s2.filter((e4) => this.viewItems[e4].priority === de.High);
    n2.push(...a2, ...o2, ...r2), "number" == typeof e3 && U(n2, e3);
    for (let _e12 = 0; 0 !== i2 && _e12 < n2.length; _e12++) {
      const _t0 = this.viewItems[n2[_e12]], _s4 = x(_t0.size + i2, _t0.minimumSize, _t0.maximumSize);
      i2 -= _s4 - _t0.size, _t0.size = _s4;
    }
  }
  layoutViews() {
    var _this$onDidChange;
    this.contentSize = this.viewItems.reduce((e4, t2) => e4 + t2.size, 0);
    let e3 = 0;
    for (const t2 of this.viewItems) t2.layout(e3), e3 += t2.size;
    (_this$onDidChange = this.onDidChange) != null && _this$onDidChange.call(this, this.viewItems.map((e4) => e4.size)), this.sashItems.forEach((e4) => e4.sash.layout()), this.updateSashEnablement();
  }
  saveProportions() {
    this.proportionalLayout && this.contentSize > 0 && (this.proportions = this.viewItems.map((e3) => e3.size / this.contentSize));
  }
  updateSashEnablement() {
    let e3 = false;
    const t2 = this.viewItems.map((t3) => e3 = t3.size - t3.minimumSize > 0 || e3);
    e3 = false;
    const i2 = this.viewItems.map((t3) => e3 = t3.maximumSize - t3.size > 0 || e3), s2 = [...this.viewItems].reverse();
    e3 = false;
    const n2 = s2.map((t3) => e3 = t3.size - t3.minimumSize > 0 || e3).reverse();
    e3 = false;
    const r2 = s2.map((t3) => e3 = t3.maximumSize - t3.size > 0 || e3).reverse();
    let o2 = 0;
    for (let _e13 = 0; _e13 < this.sashItems.length; _e13++) {
      const {
        sash: _s5
      } = this.sashItems[_e13];
      o2 += this.viewItems[_e13].size;
      const a2 = !(t2[_e13] && r2[_e13 + 1]), h2 = !(i2[_e13] && n2[_e13 + 1]);
      if (a2 && h2) {
        const _i8 = K(_e13, -1, -1), _r = K(_e13 + 1, this.viewItems.length), _a = this.findFirstSnapIndex(_i8), _h = this.findFirstSnapIndex(_r), l2 = "number" == typeof _a && !this.viewItems[_a].visible, u2 = "number" == typeof _h && !this.viewItems[_h].visible;
        l2 && n2[_e13] && (o2 > 0 || this.startSnappingEnabled) ? _s5.state = ae.Minimum : u2 && t2[_e13] && (o2 < this.contentSize || this.endSnappingEnabled) ? _s5.state = ae.Maximum : _s5.state = ae.Disabled;
      } else _s5.state = a2 && !h2 ? ae.Minimum : !a2 && h2 ? ae.Maximum : ae.Enabled;
    }
  }
  findFirstSnapIndex(e3) {
    for (const t2 of e3) {
      const _e14 = this.viewItems[t2];
      if (_e14.visible && _e14.snap) return t2;
    }
    for (const t2 of e3) {
      const _e15 = this.viewItems[t2];
      if (_e15.visible && _e15.maximumSize - _e15.minimumSize > 0) return;
      if (!_e15.visible && _e15.snap) return t2;
    }
  }
};
var ze = class {
  constructor(e3) {
    this.size = void 0, this.size = e3;
  }
  getPreferredSize() {
    return this.size;
  }
};
var we = class {
  constructor(e3, t2) {
    this.proportion = void 0, this.layoutService = void 0, this.proportion = e3, this.layoutService = t2;
  }
  getPreferredSize() {
    return this.proportion * this.layoutService.getSize();
  }
};
var ge = class {
  getPreferredSize() {
  }
};
var ye = class {
  get preferredSize() {
    return this.layoutStrategy.getPreferredSize();
  }
  set preferredSize(e3) {
    if ("number" == typeof e3) this.layoutStrategy = new ze(e3);
    else if ("string" == typeof e3) {
      const t2 = e3.trim();
      if (B(t2, "%")) {
        const _e16 = Number(t2.slice(0, -1)) / 100;
        this.layoutStrategy = new we(_e16, this.layoutService);
      } else if (B(t2, "px")) {
        const _e17 = Number(t2.slice(0, -2)) / 100;
        this.layoutStrategy = new ze(_e17);
      } else if ("number" == typeof Number.parseFloat(t2)) {
        const _e18 = Number.parseFloat(t2);
        this.layoutStrategy = new ze(_e18);
      } else this.layoutStrategy = new ge();
    } else this.layoutStrategy = new ge();
  }
  constructor(e3, t2) {
    var _t$priority;
    if (this.minimumSize = 0, this.maximumSize = Number.POSITIVE_INFINITY, this.element = void 0, this.priority = void 0, this.snap = void 0, this.layoutService = void 0, this.layoutStrategy = void 0, this.layoutService = e3, this.element = t2.element, this.minimumSize = "number" == typeof t2.minimumSize ? t2.minimumSize : 30, this.maximumSize = "number" == typeof t2.maximumSize ? t2.maximumSize : Number.POSITIVE_INFINITY, "number" == typeof t2.preferredSize) this.layoutStrategy = new ze(t2.preferredSize);
    else if ("string" == typeof t2.preferredSize) {
      const _e19 = t2.preferredSize.trim();
      if (B(_e19, "%")) {
        const _t1 = Number(_e19.slice(0, -1)) / 100;
        this.layoutStrategy = new we(_t1, this.layoutService);
      } else if (B(_e19, "px")) {
        const _t10 = Number(_e19.slice(0, -2));
        this.layoutStrategy = new ze(_t10);
      } else if ("number" == typeof Number.parseFloat(_e19)) {
        const _t11 = Number.parseFloat(_e19);
        this.layoutStrategy = new ze(_t11);
      } else this.layoutStrategy = new ge();
    } else this.layoutStrategy = new ge();
    this.priority = (_t$priority = t2.priority) != null ? _t$priority : de.Normal, this.snap = "boolean" == typeof t2.snap && t2.snap;
  }
  layout(e3) {
  }
};
function be(e3) {
  return void 0 !== e3.minSize || void 0 !== e3.maxSize || void 0 !== e3.preferredSize || void 0 !== e3.priority || void 0 !== e3.visible;
}
var Ie = (0, import_react.forwardRef)(({
  className: t2,
  children: i2
}, s2) => import_react.default.createElement("div", {
  ref: s2,
  className: S("split-view-view", M, t2)
}, i2));
Ie.displayName = "Allotment.Pane";
var xe = (0, import_react.forwardRef)(({
  children: r2,
  className: o2,
  id: l2,
  maxSize: u2 = 1 / 0,
  minSize: c2 = 30,
  proportionalLayout: m2 = true,
  separator: d2 = true,
  sizes: f2,
  defaultSizes: p2 = f2,
  snap: v2 = false,
  vertical: z2 = false,
  onChange: w2,
  onReset: g2,
  onVisibleChange: b2,
  onDragStart: I2,
  onDragEnd: x2
}, _2) => {
  const V2 = (0, import_react.useRef)(null), N2 = (0, import_react.useRef)([]), D2 = (0, import_react.useRef)(/* @__PURE__ */ new Map()), M2 = (0, import_react.useRef)(null), A2 = (0, import_react.useRef)(/* @__PURE__ */ new Map()), j2 = (0, import_react.useRef)(new $()), F2 = (0, import_react.useRef)([]), [Y2, B2] = (0, import_react.useState)(false);
  f2 && console.warn("Prop sizes is deprecated. Please use defaultSizes instead.");
  const R2 = (0, import_react.useMemo)(() => import_react.default.Children.toArray(r2).filter(import_react.default.isValidElement), [r2]), W2 = (0, import_react.useCallback)((e3) => {
    var _F$current, _M$current;
    const t2 = (_F$current = F2.current) == null ? void 0 : _F$current[e3];
    return "number" == typeof (t2 == null ? void 0 : t2.preferredSize) && ((_M$current = M2.current) != null && _M$current.resizeView(e3, Math.round(t2.preferredSize)), true);
  }, []);
  return (0, import_react.useImperativeHandle)(_2, () => ({
    reset: () => {
      if (g2) g2();
      else {
        var _M$current2;
        (_M$current2 = M2.current) == null || _M$current2.distributeViewSizes();
        for (let e3 = 0; e3 < F2.current.length; e3++) W2(e3);
      }
    },
    resize: (e3) => {
      var _M$current3;
      (_M$current3 = M2.current) == null || _M$current3.resizeViews(e3);
    }
  })), k(() => {
    let e3 = true;
    p2 && A2.current.size !== p2.length && (e3 = false, console.warn(`Expected ${p2.length} children based on defaultSizes but found ${A2.current.size}`)), e3 && p2 && (N2.current = R2.map((e4) => e4.key));
    const t2 = _extends({
      orientation: z2 ? oe.Vertical : oe.Horizontal,
      proportionalLayout: m2
    }, e3 && p2 && {
      descriptor: {
        size: p2.reduce((e4, t3) => e4 + t3, 0),
        views: p2.map((e4, t3) => {
          var _i$minSize, _i$maxSize, _i$priority, _i$snap;
          const i3 = D2.current.get(N2.current[t3]), s2 = new ye(j2.current, _extends({
            element: document.createElement("div"),
            minimumSize: (_i$minSize = i3 == null ? void 0 : i3.minSize) != null ? _i$minSize : c2,
            maximumSize: (_i$maxSize = i3 == null ? void 0 : i3.maxSize) != null ? _i$maxSize : u2,
            priority: (_i$priority = i3 == null ? void 0 : i3.priority) != null ? _i$priority : de.Normal
          }, (i3 == null ? void 0 : i3.preferredSize) && {
            preferredSize: i3 == null ? void 0 : i3.preferredSize
          }, {
            snap: (_i$snap = i3 == null ? void 0 : i3.snap) != null ? _i$snap : v2
          }));
          return F2.current.push(s2), {
            container: [...A2.current.values()][t3],
            size: e4,
            view: s2
          };
        })
      }
    });
    M2.current = new Se(V2.current, t2, w2, I2, x2), M2.current.on("sashDragStart", () => {
      var _V$current;
      (_V$current = V2.current) == null || _V$current.classList.add("split-view-sash-dragging");
    }), M2.current.on("sashDragEnd", () => {
      var _V$current2;
      (_V$current2 = V2.current) == null || _V$current2.classList.remove("split-view-sash-dragging");
    }), M2.current.on("sashchange", (e4) => {
      if (b2 && M2.current) {
        const _e20 = R2.map((e5) => e5.key);
        for (let t3 = 0; t3 < _e20.length; t3++) {
          const i3 = D2.current.get(_e20[t3]);
          void 0 !== (i3 == null ? void 0 : i3.visible) && i3.visible !== M2.current.isViewVisible(t3) && b2(t3, M2.current.isViewVisible(t3));
        }
      }
    }), M2.current.on("sashreset", (e4) => {
      if (g2) g2();
      else {
        var _M$current4;
        if (W2(e4)) return;
        if (W2(e4 + 1)) return;
        (_M$current4 = M2.current) == null || _M$current4.distributeViewSizes();
      }
    });
    const i2 = M2.current;
    return () => {
      i2.dispose();
    };
  }, []), k(() => {
    if (Y2) {
      const e3 = R2.map((e4) => e4.key), t2 = [...N2.current], i2 = e3.filter((e4) => !N2.current.includes(e4)), s2 = e3.filter((e4) => N2.current.includes(e4)), n2 = N2.current.map((t3) => !e3.includes(t3));
      for (let _e21 = n2.length - 1; _e21 >= 0; _e21--) {
        var _M$current5;
        n2[_e21] && ((_M$current5 = M2.current) != null && _M$current5.removeView(_e21), t2.splice(_e21, 1), F2.current.splice(_e21, 1));
      }
      for (const _s6 of i2) {
        var _i9$minSize, _i9$maxSize, _i9$priority, _i9$snap, _M$current6;
        const _i9 = D2.current.get(_s6), _n2 = new ye(j2.current, _extends({
          element: document.createElement("div"),
          minimumSize: (_i9$minSize = _i9 == null ? void 0 : _i9.minSize) != null ? _i9$minSize : c2,
          maximumSize: (_i9$maxSize = _i9 == null ? void 0 : _i9.maxSize) != null ? _i9$maxSize : u2,
          priority: (_i9$priority = _i9 == null ? void 0 : _i9.priority) != null ? _i9$priority : de.Normal
        }, (_i9 == null ? void 0 : _i9.preferredSize) && {
          preferredSize: _i9 == null ? void 0 : _i9.preferredSize
        }, {
          snap: (_i9$snap = _i9 == null ? void 0 : _i9.snap) != null ? _i9$snap : v2
        }));
        (_M$current6 = M2.current) != null && _M$current6.addView(A2.current.get(_s6), _n2, ce.Distribute, e3.findIndex((e4) => e4 === _s6)), t2.splice(e3.findIndex((e4) => e4 === _s6), 0, _s6), F2.current.splice(e3.findIndex((e4) => e4 === _s6), 0, _n2);
      }
      for (; !y(e3, t2); ) for (const [_i0, _s7] of e3.entries()) {
        const _e22 = t2.findIndex((e4) => e4 === _s7);
        if (_e22 !== _i0) {
          var _M$current7;
          (_M$current7 = M2.current) == null || _M$current7.moveView(A2.current.get(_s7), _e22, _i0);
          const _n3 = t2[_e22];
          t2.splice(_e22, 1), t2.splice(_i0, 0, _n3);
          break;
        }
      }
      for (const _t12 of i2) {
        var _M$current8;
        const _i1 = e3.findIndex((e4) => e4 === _t12), _s8 = F2.current[_i1].preferredSize;
        void 0 !== _s8 && ((_M$current8 = M2.current) == null ? void 0 : _M$current8.resizeView(_i1, _s8));
      }
      for (const _t13 of [...i2, ...s2]) {
        var _M$current9, _M$current0;
        const _i10 = D2.current.get(_t13), _s9 = e3.findIndex((e4) => e4 === _t13);
        _i10 && be(_i10) && void 0 !== _i10.visible && ((_M$current9 = M2.current) == null ? void 0 : _M$current9.isViewVisible(_s9)) !== _i10.visible && ((_M$current0 = M2.current) == null ? void 0 : _M$current0.setViewVisible(_s9, _i10.visible));
      }
      for (const _t14 of s2) {
        const _i11 = D2.current.get(_t14), _s0 = e3.findIndex((e4) => e4 === _t14);
        if (_i11 && be(_i11)) {
          var _M$current1;
          void 0 !== _i11.preferredSize && F2.current[_s0].preferredSize !== _i11.preferredSize && (F2.current[_s0].preferredSize = _i11.preferredSize);
          let _e23 = false;
          void 0 !== _i11.minSize && F2.current[_s0].minimumSize !== _i11.minSize && (F2.current[_s0].minimumSize = _i11.minSize, _e23 = true), void 0 !== _i11.maxSize && F2.current[_s0].maximumSize !== _i11.maxSize && (F2.current[_s0].maximumSize = _i11.maxSize, _e23 = true), _e23 && ((_M$current1 = M2.current) == null ? void 0 : _M$current1.layout());
        }
      }
      (i2.length > 0 || n2.length > 0) && (N2.current = e3);
    }
  }, [R2, Y2, u2, c2, v2]), (0, import_react.useEffect)(() => {
    M2.current && (M2.current.onDidChange = w2);
  }, [w2]), (0, import_react.useEffect)(() => {
    M2.current && (M2.current.onDidDragStart = I2);
  }, [I2]), (0, import_react.useEffect)(() => {
    M2.current && (M2.current.onDidDragEnd = x2);
  }, [x2]), E({
    ref: V2,
    onResize: ({
      width: e3,
      height: t2
    }) => {
      var _M$current10;
      e3 && t2 && ((_M$current10 = M2.current) != null && _M$current10.layout(z2 ? t2 : e3), j2.current.setSize(z2 ? t2 : e3), B2(true));
    }
  }), (0, import_react.useEffect)(() => {
    H && _e(20);
  }, []), import_react.default.createElement("div", {
    ref: V2,
    className: S("split-view", z2 ? "split-view-vertical" : "split-view-horizontal", {
      "split-view-separator-border": d2
    }, L, z2 ? P : T, {
      [C]: d2
    }, o2),
    id: l2
  }, import_react.default.createElement("div", {
    className: S("split-view-container", O)
  }, import_react.default.Children.toArray(r2).map((t2) => {
    if (!import_react.default.isValidElement(t2)) return null;
    const i2 = t2.key;
    return "Allotment.Pane" === t2.type.displayName ? (D2.current.set(i2, t2.props), import_react.default.cloneElement(t2, {
      key: i2,
      ref: (e3) => {
        const s2 = t2.ref;
        s2 && (s2.current = e3), e3 ? A2.current.set(i2, e3) : A2.current.delete(i2);
      }
    })) : import_react.default.createElement(Ie, {
      key: i2,
      ref: (e3) => {
        e3 ? A2.current.set(i2, e3) : A2.current.delete(i2);
      }
    }, t2);
  })));
});
function _e(e3) {
  const t2 = x(e3, 4, 20), i2 = x(e3, 1, 8);
  document.documentElement.style.setProperty("--sash-size", t2 + "px"), document.documentElement.style.setProperty("--sash-hover-size", i2 + "px"), (function(e4) {
    he = e4, le.emit("onDidChangeGlobalSize", e4);
  })(t2);
}
xe.displayName = "Allotment";
var Ve = Object.assign(xe, {
  Pane: Ie
});
export {
  Ve as Allotment,
  de as LayoutPriority,
  _e as setSashSize
};
/*! Bundled license information:

allotment/dist/modern.mjs:
  (*!
  	Copyright (c) 2018 Jed Watson.
  	Licensed under the MIT License (MIT), see
  	http://jedwatson.github.io/classnames
  *)
*/
//# sourceMappingURL=allotment.js.map
