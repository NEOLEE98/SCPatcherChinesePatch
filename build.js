(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function dedupe(deps) {
    var newDeps = [];
    for (var i = 0, l = deps.length; i < l; i++)
      if (indexOf.call(newDeps, deps[i]) == -1)
        newDeps.push(deps[i])
    return newDeps;
  }

  function register(name, deps, declare, execute) {
    if (typeof name != 'string')
      throw "System.register provided no module name";

    var entry;

    // dynamic
    if (typeof declare == 'boolean') {
      entry = {
        declarative: false,
        deps: deps,
        execute: execute,
        executingRequire: declare
      };
    }
    else {
      // ES6 declarative
      entry = {
        declarative: true,
        deps: deps,
        declare: declare
      };
    }

    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry; 

    entry.deps = dedupe(entry.deps);

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }

  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          var importerIndex = indexOf.call(importerModule.dependencies, module);
          importerModule.setters[importerIndex](exports);
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    if (!module.setters || !module.execute)
      throw new TypeError("Invalid System.register form for " + entry.name);

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        if (depEntry.module.exports && depEntry.module.exports.__esModule)
          depExports = depEntry.module.exports;
        else
          depExports = { 'default': depEntry.module.exports, __useDefault: true };
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    var module = entry.module.exports;

    if (!module || !entry.declarative && module.__esModule !== true)
      module = { 'default': module, __useDefault: true };

    // return the defined module object
    return modules[name] = module;
  };

  return function(mains, declare) {

    var System;
    var System = {
      register: register, 
      get: load, 
      set: function(name, module) {
        modules[name] = module; 
      },
      newModule: function(module) {
        return module;
      },
      global: global 
    };
    System.set('@empty', {});

    declare(System);

    for (var i = 0; i < mains.length; i++)
      load(mains[i]);
  }

})(typeof window != 'undefined' ? window : global)
/* (['mainModule'], function(System) {
  System.register(...);
}); */

(['src/scripts/index'], function(System) {

System.register("npm:core-js@0.9.6/library/modules/$.fw", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function($) {
    $.FW = false;
    $.path = $.core;
    return $;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.string-at", ["npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$");
  module.exports = function(TO_STRING) {
    return function(that, pos) {
      var s = String($.assertDefined(that)),
          i = $.toInteger(pos),
          l = s.length,
          a,
          b;
      if (i < 0 || i >= l)
        return TO_STRING ? '' : undefined;
      a = s.charCodeAt(i);
      return a < 0xd800 || a > 0xdbff || i + 1 === l || (b = s.charCodeAt(i + 1)) < 0xdc00 || b > 0xdfff ? TO_STRING ? s.charAt(i) : a : TO_STRING ? s.slice(i, i + 2) : (a - 0xd800 << 10) + (b - 0xdc00) + 0x10000;
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.uid", ["npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var sid = 0;
  function uid(key) {
    return 'Symbol(' + key + ')_' + (++sid + Math.random()).toString(36);
  }
  uid.safe = require("npm:core-js@0.9.6/library/modules/$").g.Symbol || uid;
  module.exports = uid;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.wks", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.uid"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var global = require("npm:core-js@0.9.6/library/modules/$").g,
      store = {};
  module.exports = function(name) {
    return store[name] || (store[name] = global.Symbol && global.Symbol[name] || require("npm:core-js@0.9.6/library/modules/$.uid").safe('Symbol.' + name));
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.assert", ["npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$");
  function assert(condition, msg1, msg2) {
    if (!condition)
      throw TypeError(msg2 ? msg1 + msg2 : msg1);
  }
  assert.def = $.assertDefined;
  assert.fn = function(it) {
    if (!$.isFunction(it))
      throw TypeError(it + ' is not a function!');
    return it;
  };
  assert.obj = function(it) {
    if (!$.isObject(it))
      throw TypeError(it + ' is not an object!');
    return it;
  };
  assert.inst = function(it, Constructor, name) {
    if (!(it instanceof Constructor))
      throw TypeError(name + ": use the 'new' operator!");
    return it;
  };
  module.exports = assert;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.def", ["npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      global = $.g,
      core = $.core,
      isFunction = $.isFunction;
  function ctx(fn, that) {
    return function() {
      return fn.apply(that, arguments);
    };
  }
  $def.F = 1;
  $def.G = 2;
  $def.S = 4;
  $def.P = 8;
  $def.B = 16;
  $def.W = 32;
  function $def(type, name, source) {
    var key,
        own,
        out,
        exp,
        isGlobal = type & $def.G,
        target = isGlobal ? global : type & $def.S ? global[name] : (global[name] || {}).prototype,
        exports = isGlobal ? core : core[name] || (core[name] = {});
    if (isGlobal)
      source = name;
    for (key in source) {
      own = !(type & $def.F) && target && key in target;
      if (own && key in exports)
        continue;
      out = own ? target[key] : source[key];
      if (isGlobal && !isFunction(target[key]))
        exp = source[key];
      else if (type & $def.B && own)
        exp = ctx(out, global);
      else if (type & $def.W && target[key] == out)
        !function(C) {
          exp = function(param) {
            return this instanceof C ? new C(param) : C(param);
          };
          exp.prototype = C.prototype;
        }(out);
      else
        exp = type & $def.P && isFunction(out) ? ctx(Function.call, out) : out;
      $.hide(exports, key, exp);
    }
  }
  module.exports = $def;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.ctx", ["npm:core-js@0.9.6/library/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var assertFunction = require("npm:core-js@0.9.6/library/modules/$.assert").fn;
  module.exports = function(fn, that, length) {
    assertFunction(fn);
    if (~length && that === undefined)
      return fn;
    switch (length) {
      case 1:
        return function(a) {
          return fn.call(that, a);
        };
      case 2:
        return function(a, b) {
          return fn.call(that, a, b);
        };
      case 3:
        return function(a, b, c) {
          return fn.call(that, a, b, c);
        };
    }
    return function() {
      return fn.apply(that, arguments);
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.iter-call", ["npm:core-js@0.9.6/library/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var assertObject = require("npm:core-js@0.9.6/library/modules/$.assert").obj;
  function close(iterator) {
    var ret = iterator['return'];
    if (ret !== undefined)
      assertObject(ret.call(iterator));
  }
  function call(iterator, fn, value, entries) {
    try {
      return entries ? fn(assertObject(value)[0], value[1]) : fn(value);
    } catch (e) {
      close(iterator);
      throw e;
    }
  }
  call.close = close;
  module.exports = call;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.iter-detect", ["npm:core-js@0.9.6/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var SYMBOL_ITERATOR = require("npm:core-js@0.9.6/library/modules/$.wks")('iterator'),
      SAFE_CLOSING = false;
  try {
    var riter = [7][SYMBOL_ITERATOR]();
    riter['return'] = function() {
      SAFE_CLOSING = true;
    };
    Array.from(riter, function() {
      throw 2;
    });
  } catch (e) {}
  module.exports = function(exec) {
    if (!SAFE_CLOSING)
      return false;
    var safe = false;
    try {
      var arr = [7],
          iter = arr[SYMBOL_ITERATOR]();
      iter.next = function() {
        safe = true;
      };
      arr[SYMBOL_ITERATOR] = function() {
        return iter;
      };
      exec(arr);
    } catch (e) {}
    return safe;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.unscope", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      UNSCOPABLES = require("npm:core-js@0.9.6/library/modules/$.wks")('unscopables');
  if ($.FW && !(UNSCOPABLES in []))
    $.hide(Array.prototype, UNSCOPABLES, {});
  module.exports = function(key) {
    if ($.FW)
      [][UNSCOPABLES][key] = true;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/core.iter-helpers", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.iter"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var core = require("npm:core-js@0.9.6/library/modules/$").core,
      $iter = require("npm:core-js@0.9.6/library/modules/$.iter");
  core.isIterable = $iter.is;
  core.getIterator = $iter.get;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/fn/get-iterator", ["npm:core-js@0.9.6/library/modules/web.dom.iterable", "npm:core-js@0.9.6/library/modules/es6.string.iterator", "npm:core-js@0.9.6/library/modules/core.iter-helpers", "npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/library/modules/web.dom.iterable");
  require("npm:core-js@0.9.6/library/modules/es6.string.iterator");
  require("npm:core-js@0.9.6/library/modules/core.iter-helpers");
  module.exports = require("npm:core-js@0.9.6/library/modules/$").core.getIterator;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/es6.object.to-string", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.cof", "npm:core-js@0.9.6/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      cof = require("npm:core-js@0.9.6/library/modules/$.cof"),
      tmp = {};
  tmp[require("npm:core-js@0.9.6/library/modules/$.wks")('toStringTag')] = 'z';
  if ($.FW && cof(tmp) != 'z')
    $.hide(Object.prototype, 'toString', function toString() {
      return '[object ' + cof.classof(this) + ']';
    });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.for-of", ["npm:core-js@0.9.6/library/modules/$.ctx", "npm:core-js@0.9.6/library/modules/$.iter", "npm:core-js@0.9.6/library/modules/$.iter-call"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var ctx = require("npm:core-js@0.9.6/library/modules/$.ctx"),
      get = require("npm:core-js@0.9.6/library/modules/$.iter").get,
      call = require("npm:core-js@0.9.6/library/modules/$.iter-call");
  module.exports = function(iterable, entries, fn, that) {
    var iterator = get(iterable),
        f = ctx(fn, that, entries ? 2 : 1),
        step;
    while (!(step = iterator.next()).done) {
      if (call(iterator, f, step.value, entries) === false) {
        return call.close(iterator);
      }
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.set-proto", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.assert", "npm:core-js@0.9.6/library/modules/$.ctx"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      assert = require("npm:core-js@0.9.6/library/modules/$.assert");
  function check(O, proto) {
    assert.obj(O);
    assert(proto === null || $.isObject(proto), proto, ": can't set as prototype!");
  }
  module.exports = {
    set: Object.setPrototypeOf || ('__proto__' in {} ? function(buggy, set) {
      try {
        set = require("npm:core-js@0.9.6/library/modules/$.ctx")(Function.call, $.getDesc(Object.prototype, '__proto__').set, 2);
        set({}, []);
      } catch (e) {
        buggy = true;
      }
      return function setPrototypeOf(O, proto) {
        check(O, proto);
        if (buggy)
          O.__proto__ = proto;
        else
          set(O, proto);
        return O;
      };
    }() : undefined),
    check: check
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.species", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      SPECIES = require("npm:core-js@0.9.6/library/modules/$.wks")('species');
  module.exports = function(C) {
    if ($.DESC && !(SPECIES in C))
      $.setDesc(C, SPECIES, {
        configurable: true,
        get: $.that
      });
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.invoke", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function(fn, args, that) {
    var un = that === undefined;
    switch (args.length) {
      case 0:
        return un ? fn() : fn.call(that);
      case 1:
        return un ? fn(args[0]) : fn.call(that, args[0]);
      case 2:
        return un ? fn(args[0], args[1]) : fn.call(that, args[0], args[1]);
      case 3:
        return un ? fn(args[0], args[1], args[2]) : fn.call(that, args[0], args[1], args[2]);
      case 4:
        return un ? fn(args[0], args[1], args[2], args[3]) : fn.call(that, args[0], args[1], args[2], args[3]);
      case 5:
        return un ? fn(args[0], args[1], args[2], args[3], args[4]) : fn.call(that, args[0], args[1], args[2], args[3], args[4]);
    }
    return fn.apply(that, args);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.dom-create", ["npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      document = $.g.document,
      isObject = $.isObject,
      is = isObject(document) && isObject(document.createElement);
  module.exports = function(it) {
    return is ? document.createElement(it) : {};
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:process@0.10.1/browser", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var process = module.exports = {};
  var queue = [];
  var draining = false;
  function drainQueue() {
    if (draining) {
      return ;
    }
    draining = true;
    var currentQueue;
    var len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      var i = -1;
      while (++i < len) {
        currentQueue[i]();
      }
      len = queue.length;
    }
    draining = false;
  }
  process.nextTick = function(fun) {
    queue.push(fun);
    if (!draining) {
      setTimeout(drainQueue, 0);
    }
  };
  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = '';
  process.versions = {};
  function noop() {}
  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;
  process.binding = function(name) {
    throw new Error('process.binding is not supported');
  };
  process.cwd = function() {
    return '/';
  };
  process.chdir = function(dir) {
    throw new Error('process.chdir is not supported');
  };
  process.umask = function() {
    return 0;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.fw", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function($) {
    $.FW = true;
    $.path = $.g;
    return $;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.dom-create", ["npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      document = $.g.document,
      isObject = $.isObject,
      is = isObject(document) && isObject(document.createElement);
  module.exports = function(it) {
    return is ? document.createElement(it) : {};
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.uid", ["npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var sid = 0;
  function uid(key) {
    return 'Symbol(' + key + ')_' + (++sid + Math.random()).toString(36);
  }
  uid.safe = require("npm:core-js@0.9.6/modules/$").g.Symbol || uid;
  module.exports = uid;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.def", ["npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      global = $.g,
      core = $.core,
      isFunction = $.isFunction;
  function ctx(fn, that) {
    return function() {
      return fn.apply(that, arguments);
    };
  }
  global.core = core;
  $def.F = 1;
  $def.G = 2;
  $def.S = 4;
  $def.P = 8;
  $def.B = 16;
  $def.W = 32;
  function $def(type, name, source) {
    var key,
        own,
        out,
        exp,
        isGlobal = type & $def.G,
        target = isGlobal ? global : type & $def.S ? global[name] : (global[name] || {}).prototype,
        exports = isGlobal ? core : core[name] || (core[name] = {});
    if (isGlobal)
      source = name;
    for (key in source) {
      own = !(type & $def.F) && target && key in target;
      out = (own ? target : source)[key];
      if (type & $def.B && own)
        exp = ctx(out, global);
      else
        exp = type & $def.P && isFunction(out) ? ctx(Function.call, out) : out;
      if (target && !own) {
        if (isGlobal)
          target[key] = out;
        else
          delete target[key] && $.hide(target, key, out);
      }
      if (exports[key] != out)
        $.hide(exports, key, exp);
    }
  }
  module.exports = $def;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.invoke", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function(fn, args, that) {
    var un = that === undefined;
    switch (args.length) {
      case 0:
        return un ? fn() : fn.call(that);
      case 1:
        return un ? fn(args[0]) : fn.call(that, args[0]);
      case 2:
        return un ? fn(args[0], args[1]) : fn.call(that, args[0], args[1]);
      case 3:
        return un ? fn(args[0], args[1], args[2]) : fn.call(that, args[0], args[1], args[2]);
      case 4:
        return un ? fn(args[0], args[1], args[2], args[3]) : fn.call(that, args[0], args[1], args[2], args[3]);
      case 5:
        return un ? fn(args[0], args[1], args[2], args[3], args[4]) : fn.call(that, args[0], args[1], args[2], args[3], args[4]);
    }
    return fn.apply(that, args);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.assert", ["npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$");
  function assert(condition, msg1, msg2) {
    if (!condition)
      throw TypeError(msg2 ? msg1 + msg2 : msg1);
  }
  assert.def = $.assertDefined;
  assert.fn = function(it) {
    if (!$.isFunction(it))
      throw TypeError(it + ' is not a function!');
    return it;
  };
  assert.obj = function(it) {
    if (!$.isObject(it))
      throw TypeError(it + ' is not an object!');
    return it;
  };
  assert.inst = function(it, Constructor, name) {
    if (!(it instanceof Constructor))
      throw TypeError(name + ": use the 'new' operator!");
    return it;
  };
  module.exports = assert;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.array-includes", ["npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$");
  module.exports = function(IS_INCLUDES) {
    return function($this, el, fromIndex) {
      var O = $.toObject($this),
          length = $.toLength(O.length),
          index = $.toIndex(fromIndex, length),
          value;
      if (IS_INCLUDES && el != el)
        while (length > index) {
          value = O[index++];
          if (value != value)
            return true;
        }
      else
        for (; length > index; index++)
          if (IS_INCLUDES || index in O) {
            if (O[index] === el)
              return IS_INCLUDES || index;
          }
      return !IS_INCLUDES && -1;
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.replacer", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  module.exports = function(regExp, replace, isStatic) {
    var replacer = replace === Object(replace) ? function(part) {
      return replace[part];
    } : replace;
    return function(it) {
      return String(isStatic ? it : this).replace(regExp, replacer);
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.throws", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function(exec) {
    try {
      exec();
      return false;
    } catch (e) {
      return true;
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.keyof", ["npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$");
  module.exports = function(object, el) {
    var O = $.toObject(object),
        keys = $.getKeys(O),
        length = keys.length,
        index = 0,
        key;
    while (length > index)
      if (O[key = keys[index++]] === el)
        return key;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.enum-keys", ["npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$");
  module.exports = function(it) {
    var keys = $.getKeys(it),
        getDesc = $.getDesc,
        getSymbols = $.getSymbols;
    if (getSymbols)
      $.each.call(getSymbols(it), function(key) {
        if (getDesc(it, key).enumerable)
          keys.push(key);
      });
    return keys;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.assign", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.enum-keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      enumKeys = require("npm:core-js@0.9.6/modules/$.enum-keys");
  module.exports = Object.assign || function assign(target, source) {
    var T = Object($.assertDefined(target)),
        l = arguments.length,
        i = 1;
    while (l > i) {
      var S = $.ES5Object(arguments[i++]),
          keys = enumKeys(S),
          length = keys.length,
          j = 0,
          key;
      while (length > j)
        T[key = keys[j++]] = S[key];
    }
    return T;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.object.is", ["npm:core-js@0.9.6/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/modules/$.def");
  $def($def.S, 'Object', {is: function is(x, y) {
      return x === y ? x !== 0 || 1 / x === 1 / y : x != x && y != y;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.set-proto", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.assert", "npm:core-js@0.9.6/modules/$.ctx"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      assert = require("npm:core-js@0.9.6/modules/$.assert");
  function check(O, proto) {
    assert.obj(O);
    assert(proto === null || $.isObject(proto), proto, ": can't set as prototype!");
  }
  module.exports = {
    set: Object.setPrototypeOf || ('__proto__' in {} ? function(buggy, set) {
      try {
        set = require("npm:core-js@0.9.6/modules/$.ctx")(Function.call, $.getDesc(Object.prototype, '__proto__').set, 2);
        set({}, []);
      } catch (e) {
        buggy = true;
      }
      return function setPrototypeOf(O, proto) {
        check(O, proto);
        if (buggy)
          O.__proto__ = proto;
        else
          set(O, proto);
        return O;
      };
    }() : undefined),
    check: check
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.object.to-string", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.cof", "npm:core-js@0.9.6/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      cof = require("npm:core-js@0.9.6/modules/$.cof"),
      tmp = {};
  tmp[require("npm:core-js@0.9.6/modules/$.wks")('toStringTag')] = 'z';
  if ($.FW && cof(tmp) != 'z')
    $.hide(Object.prototype, 'toString', function toString() {
      return '[object ' + cof.classof(this) + ']';
    });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.object.statics-accept-primitives", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      isObject = $.isObject,
      toObject = $.toObject;
  function wrapObjectMethod(METHOD, MODE) {
    var fn = ($.core.Object || {})[METHOD] || Object[METHOD],
        f = 0,
        o = {};
    o[METHOD] = MODE == 1 ? function(it) {
      return isObject(it) ? fn(it) : it;
    } : MODE == 2 ? function(it) {
      return isObject(it) ? fn(it) : true;
    } : MODE == 3 ? function(it) {
      return isObject(it) ? fn(it) : false;
    } : MODE == 4 ? function getOwnPropertyDescriptor(it, key) {
      return fn(toObject(it), key);
    } : MODE == 5 ? function getPrototypeOf(it) {
      return fn(Object($.assertDefined(it)));
    } : function(it) {
      return fn(toObject(it));
    };
    try {
      fn('z');
    } catch (e) {
      f = 1;
    }
    $def($def.S + $def.F * f, 'Object', o);
  }
  wrapObjectMethod('freeze', 1);
  wrapObjectMethod('seal', 1);
  wrapObjectMethod('preventExtensions', 1);
  wrapObjectMethod('isFrozen', 2);
  wrapObjectMethod('isSealed', 2);
  wrapObjectMethod('isExtensible', 3);
  wrapObjectMethod('getOwnPropertyDescriptor', 4);
  wrapObjectMethod('getPrototypeOf', 5);
  wrapObjectMethod('keys');
  wrapObjectMethod('getOwnPropertyNames');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.function.name", ["npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      NAME = 'name',
      setDesc = $.setDesc,
      FunctionProto = Function.prototype;
  NAME in FunctionProto || $.FW && $.DESC && setDesc(FunctionProto, NAME, {
    configurable: true,
    get: function() {
      var match = String(this).match(/^\s*function ([^ (]*)/),
          name = match ? match[1] : '';
      $.has(this, NAME) || setDesc(this, NAME, $.desc(5, name));
      return name;
    },
    set: function(value) {
      $.has(this, NAME) || setDesc(this, NAME, $.desc(0, value));
    }
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.function.has-instance", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      HAS_INSTANCE = require("npm:core-js@0.9.6/modules/$.wks")('hasInstance'),
      FunctionProto = Function.prototype;
  if (!(HAS_INSTANCE in FunctionProto))
    $.setDesc(FunctionProto, HAS_INSTANCE, {value: function(O) {
        if (!$.isFunction(this) || !$.isObject(O))
          return false;
        if (!$.isObject(this.prototype))
          return O instanceof this;
        while (O = $.getProto(O))
          if (this.prototype === O)
            return true;
        return false;
      }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.number.constructor", ["npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      isObject = $.isObject,
      isFunction = $.isFunction,
      NUMBER = 'Number',
      $Number = $.g[NUMBER],
      Base = $Number,
      proto = $Number.prototype;
  function toPrimitive(it) {
    var fn,
        val;
    if (isFunction(fn = it.valueOf) && !isObject(val = fn.call(it)))
      return val;
    if (isFunction(fn = it.toString) && !isObject(val = fn.call(it)))
      return val;
    throw TypeError("Can't convert object to number");
  }
  function toNumber(it) {
    if (isObject(it))
      it = toPrimitive(it);
    if (typeof it == 'string' && it.length > 2 && it.charCodeAt(0) == 48) {
      var binary = false;
      switch (it.charCodeAt(1)) {
        case 66:
        case 98:
          binary = true;
        case 79:
        case 111:
          return parseInt(it.slice(2), binary ? 2 : 8);
      }
    }
    return +it;
  }
  if ($.FW && !($Number('0o1') && $Number('0b1'))) {
    $Number = function Number(it) {
      return this instanceof $Number ? new Base(toNumber(it)) : toNumber(it);
    };
    $.each.call($.DESC ? $.getNames(Base) : ('MAX_VALUE,MIN_VALUE,NaN,NEGATIVE_INFINITY,POSITIVE_INFINITY,' + 'EPSILON,isFinite,isInteger,isNaN,isSafeInteger,MAX_SAFE_INTEGER,' + 'MIN_SAFE_INTEGER,parseFloat,parseInt,isInteger').split(','), function(key) {
      if ($.has(Base, key) && !$.has($Number, key)) {
        $.setDesc($Number, key, $.getDesc(Base, key));
      }
    });
    $Number.prototype = proto;
    proto.constructor = $Number;
    $.hide($.g, NUMBER, $Number);
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.number.statics", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      abs = Math.abs,
      floor = Math.floor,
      _isFinite = $.g.isFinite,
      MAX_SAFE_INTEGER = 0x1fffffffffffff;
  function isInteger(it) {
    return !$.isObject(it) && _isFinite(it) && floor(it) === it;
  }
  $def($def.S, 'Number', {
    EPSILON: Math.pow(2, -52),
    isFinite: function isFinite(it) {
      return typeof it == 'number' && _isFinite(it);
    },
    isInteger: isInteger,
    isNaN: function isNaN(number) {
      return number != number;
    },
    isSafeInteger: function isSafeInteger(number) {
      return isInteger(number) && abs(number) <= MAX_SAFE_INTEGER;
    },
    MAX_SAFE_INTEGER: MAX_SAFE_INTEGER,
    MIN_SAFE_INTEGER: -MAX_SAFE_INTEGER,
    parseFloat: parseFloat,
    parseInt: parseInt
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.math", ["npm:core-js@0.9.6/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Infinity = 1 / 0,
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      E = Math.E,
      pow = Math.pow,
      abs = Math.abs,
      exp = Math.exp,
      log = Math.log,
      sqrt = Math.sqrt,
      ceil = Math.ceil,
      floor = Math.floor,
      EPSILON = pow(2, -52),
      EPSILON32 = pow(2, -23),
      MAX32 = pow(2, 127) * (2 - EPSILON32),
      MIN32 = pow(2, -126);
  function roundTiesToEven(n) {
    return n + 1 / EPSILON - 1 / EPSILON;
  }
  function sign(x) {
    return (x = +x) == 0 || x != x ? x : x < 0 ? -1 : 1;
  }
  function asinh(x) {
    return !isFinite(x = +x) || x == 0 ? x : x < 0 ? -asinh(-x) : log(x + sqrt(x * x + 1));
  }
  function expm1(x) {
    return (x = +x) == 0 ? x : x > -1e-6 && x < 1e-6 ? x + x * x / 2 : exp(x) - 1;
  }
  $def($def.S, 'Math', {
    acosh: function acosh(x) {
      return (x = +x) < 1 ? NaN : isFinite(x) ? log(x / E + sqrt(x + 1) * sqrt(x - 1) / E) + 1 : x;
    },
    asinh: asinh,
    atanh: function atanh(x) {
      return (x = +x) == 0 ? x : log((1 + x) / (1 - x)) / 2;
    },
    cbrt: function cbrt(x) {
      return sign(x = +x) * pow(abs(x), 1 / 3);
    },
    clz32: function clz32(x) {
      return (x >>>= 0) ? 31 - floor(log(x + 0.5) * Math.LOG2E) : 32;
    },
    cosh: function cosh(x) {
      return (exp(x = +x) + exp(-x)) / 2;
    },
    expm1: expm1,
    fround: function fround(x) {
      var $abs = abs(x),
          $sign = sign(x),
          a,
          result;
      if ($abs < MIN32)
        return $sign * roundTiesToEven($abs / MIN32 / EPSILON32) * MIN32 * EPSILON32;
      a = (1 + EPSILON32 / EPSILON) * $abs;
      result = a - (a - $abs);
      if (result > MAX32 || result != result)
        return $sign * Infinity;
      return $sign * result;
    },
    hypot: function hypot(value1, value2) {
      var sum = 0,
          len1 = arguments.length,
          len2 = len1,
          args = Array(len1),
          larg = -Infinity,
          arg;
      while (len1--) {
        arg = args[len1] = +arguments[len1];
        if (arg == Infinity || arg == -Infinity)
          return Infinity;
        if (arg > larg)
          larg = arg;
      }
      larg = arg || 1;
      while (len2--)
        sum += pow(args[len2] / larg, 2);
      return larg * sqrt(sum);
    },
    imul: function imul(x, y) {
      var UInt16 = 0xffff,
          xn = +x,
          yn = +y,
          xl = UInt16 & xn,
          yl = UInt16 & yn;
      return 0 | xl * yl + ((UInt16 & xn >>> 16) * yl + xl * (UInt16 & yn >>> 16) << 16 >>> 0);
    },
    log1p: function log1p(x) {
      return (x = +x) > -1e-8 && x < 1e-8 ? x - x * x / 2 : log(1 + x);
    },
    log10: function log10(x) {
      return log(x) / Math.LN10;
    },
    log2: function log2(x) {
      return log(x) / Math.LN2;
    },
    sign: sign,
    sinh: function sinh(x) {
      return abs(x = +x) < 1 ? (expm1(x) - expm1(-x)) / 2 : (exp(x - 1) - exp(-x - 1)) * (E / 2);
    },
    tanh: function tanh(x) {
      var a = expm1(x = +x),
          b = expm1(-x);
      return a == Infinity ? 1 : b == Infinity ? -1 : (a - b) / (exp(x) + exp(-x));
    },
    trunc: function trunc(it) {
      return (it > 0 ? floor : ceil)(it);
    }
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.string.from-code-point", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/modules/$.def"),
      toIndex = require("npm:core-js@0.9.6/modules/$").toIndex,
      fromCharCode = String.fromCharCode,
      $fromCodePoint = String.fromCodePoint;
  $def($def.S + $def.F * (!!$fromCodePoint && $fromCodePoint.length != 1), 'String', {fromCodePoint: function fromCodePoint(x) {
      var res = [],
          len = arguments.length,
          i = 0,
          code;
      while (len > i) {
        code = +arguments[i++];
        if (toIndex(code, 0x10ffff) !== code)
          throw RangeError(code + ' is not a valid code point');
        res.push(code < 0x10000 ? fromCharCode(code) : fromCharCode(((code -= 0x10000) >> 10) + 0xd800, code % 0x400 + 0xdc00));
      }
      return res.join('');
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.string.raw", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      $def = require("npm:core-js@0.9.6/modules/$.def");
  $def($def.S, 'String', {raw: function raw(callSite) {
      var tpl = $.toObject(callSite.raw),
          len = $.toLength(tpl.length),
          sln = arguments.length,
          res = [],
          i = 0;
      while (len > i) {
        res.push(String(tpl[i++]));
        if (i < sln)
          res.push(String(arguments[i]));
      }
      return res.join('');
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.string-at", ["npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$");
  module.exports = function(TO_STRING) {
    return function(that, pos) {
      var s = String($.assertDefined(that)),
          i = $.toInteger(pos),
          l = s.length,
          a,
          b;
      if (i < 0 || i >= l)
        return TO_STRING ? '' : undefined;
      a = s.charCodeAt(i);
      return a < 0xd800 || a > 0xdbff || i + 1 === l || (b = s.charCodeAt(i + 1)) < 0xdc00 || b > 0xdfff ? TO_STRING ? s.charAt(i) : a : TO_STRING ? s.slice(i, i + 2) : (a - 0xd800 << 10) + (b - 0xdc00) + 0x10000;
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.iter", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.cof", "npm:core-js@0.9.6/modules/$.assert", "npm:core-js@0.9.6/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      cof = require("npm:core-js@0.9.6/modules/$.cof"),
      assertObject = require("npm:core-js@0.9.6/modules/$.assert").obj,
      SYMBOL_ITERATOR = require("npm:core-js@0.9.6/modules/$.wks")('iterator'),
      FF_ITERATOR = '@@iterator',
      Iterators = {},
      IteratorPrototype = {};
  setIterator(IteratorPrototype, $.that);
  function setIterator(O, value) {
    $.hide(O, SYMBOL_ITERATOR, value);
    if (FF_ITERATOR in [])
      $.hide(O, FF_ITERATOR, value);
  }
  module.exports = {
    BUGGY: 'keys' in [] && !('next' in [].keys()),
    Iterators: Iterators,
    step: function(done, value) {
      return {
        value: value,
        done: !!done
      };
    },
    is: function(it) {
      var O = Object(it),
          Symbol = $.g.Symbol,
          SYM = Symbol && Symbol.iterator || FF_ITERATOR;
      return SYM in O || SYMBOL_ITERATOR in O || $.has(Iterators, cof.classof(O));
    },
    get: function(it) {
      var Symbol = $.g.Symbol,
          ext = it[Symbol && Symbol.iterator || FF_ITERATOR],
          getIter = ext || it[SYMBOL_ITERATOR] || Iterators[cof.classof(it)];
      return assertObject(getIter.call(it));
    },
    set: setIterator,
    create: function(Constructor, NAME, next, proto) {
      Constructor.prototype = $.create(proto || IteratorPrototype, {next: $.desc(1, next)});
      cof.set(Constructor, NAME + ' Iterator');
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.iter-define", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.cof", "npm:core-js@0.9.6/modules/$.iter", "npm:core-js@0.9.6/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/modules/$.def"),
      $ = require("npm:core-js@0.9.6/modules/$"),
      cof = require("npm:core-js@0.9.6/modules/$.cof"),
      $iter = require("npm:core-js@0.9.6/modules/$.iter"),
      SYMBOL_ITERATOR = require("npm:core-js@0.9.6/modules/$.wks")('iterator'),
      FF_ITERATOR = '@@iterator',
      KEYS = 'keys',
      VALUES = 'values',
      Iterators = $iter.Iterators;
  module.exports = function(Base, NAME, Constructor, next, DEFAULT, IS_SET, FORCE) {
    $iter.create(Constructor, NAME, next);
    function createMethod(kind) {
      function $$(that) {
        return new Constructor(that, kind);
      }
      switch (kind) {
        case KEYS:
          return function keys() {
            return $$(this);
          };
        case VALUES:
          return function values() {
            return $$(this);
          };
      }
      return function entries() {
        return $$(this);
      };
    }
    var TAG = NAME + ' Iterator',
        proto = Base.prototype,
        _native = proto[SYMBOL_ITERATOR] || proto[FF_ITERATOR] || DEFAULT && proto[DEFAULT],
        _default = _native || createMethod(DEFAULT),
        methods,
        key;
    if (_native) {
      var IteratorPrototype = $.getProto(_default.call(new Base));
      cof.set(IteratorPrototype, TAG, true);
      if ($.FW && $.has(proto, FF_ITERATOR))
        $iter.set(IteratorPrototype, $.that);
    }
    if ($.FW)
      $iter.set(proto, _default);
    Iterators[NAME] = _default;
    Iterators[TAG] = $.that;
    if (DEFAULT) {
      methods = {
        keys: IS_SET ? _default : createMethod(KEYS),
        values: DEFAULT == VALUES ? _default : createMethod(VALUES),
        entries: DEFAULT != VALUES ? _default : createMethod('entries')
      };
      if (FORCE)
        for (key in methods) {
          if (!(key in proto))
            $.hide(proto, key, methods[key]);
        }
      else
        $def($def.P + $def.F * $iter.BUGGY, NAME, methods);
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.string.code-point-at", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.string-at"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $def = require("npm:core-js@0.9.6/modules/$.def"),
      $at = require("npm:core-js@0.9.6/modules/$.string-at")(false);
  $def($def.P, 'String', {codePointAt: function codePointAt(pos) {
      return $at(this, pos);
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.string.ends-with", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.cof", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.throws"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      cof = require("npm:core-js@0.9.6/modules/$.cof"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      toLength = $.toLength;
  $def($def.P + $def.F * !require("npm:core-js@0.9.6/modules/$.throws")(function() {
    'q'.endsWith(/./);
  }), 'String', {endsWith: function endsWith(searchString) {
      if (cof(searchString) == 'RegExp')
        throw TypeError();
      var that = String($.assertDefined(this)),
          endPosition = arguments[1],
          len = toLength(that.length),
          end = endPosition === undefined ? len : Math.min(toLength(endPosition), len);
      searchString += '';
      return that.slice(end - searchString.length, end) === searchString;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.string.includes", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.cof", "npm:core-js@0.9.6/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      cof = require("npm:core-js@0.9.6/modules/$.cof"),
      $def = require("npm:core-js@0.9.6/modules/$.def");
  $def($def.P, 'String', {includes: function includes(searchString) {
      if (cof(searchString) == 'RegExp')
        throw TypeError();
      return !!~String($.assertDefined(this)).indexOf(searchString, arguments[1]);
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.string-repeat", ["npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$");
  module.exports = function repeat(count) {
    var str = String($.assertDefined(this)),
        res = '',
        n = $.toInteger(count);
    if (n < 0 || n == Infinity)
      throw RangeError("Count can't be negative");
    for (; n > 0; (n >>>= 1) && (str += str))
      if (n & 1)
        res += str;
    return res;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.string.starts-with", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.cof", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.throws"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      cof = require("npm:core-js@0.9.6/modules/$.cof"),
      $def = require("npm:core-js@0.9.6/modules/$.def");
  $def($def.P + $def.F * !require("npm:core-js@0.9.6/modules/$.throws")(function() {
    'q'.startsWith(/./);
  }), 'String', {startsWith: function startsWith(searchString) {
      if (cof(searchString) == 'RegExp')
        throw TypeError();
      var that = String($.assertDefined(this)),
          index = $.toLength(Math.min(arguments[1], that.length));
      searchString += '';
      return that.slice(index, index + searchString.length) === searchString;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.iter-call", ["npm:core-js@0.9.6/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var assertObject = require("npm:core-js@0.9.6/modules/$.assert").obj;
  function close(iterator) {
    var ret = iterator['return'];
    if (ret !== undefined)
      assertObject(ret.call(iterator));
  }
  function call(iterator, fn, value, entries) {
    try {
      return entries ? fn(assertObject(value)[0], value[1]) : fn(value);
    } catch (e) {
      close(iterator);
      throw e;
    }
  }
  call.close = close;
  module.exports = call;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.iter-detect", ["npm:core-js@0.9.6/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var SYMBOL_ITERATOR = require("npm:core-js@0.9.6/modules/$.wks")('iterator'),
      SAFE_CLOSING = false;
  try {
    var riter = [7][SYMBOL_ITERATOR]();
    riter['return'] = function() {
      SAFE_CLOSING = true;
    };
    Array.from(riter, function() {
      throw 2;
    });
  } catch (e) {}
  module.exports = function(exec) {
    if (!SAFE_CLOSING)
      return false;
    var safe = false;
    try {
      var arr = [7],
          iter = arr[SYMBOL_ITERATOR]();
      iter.next = function() {
        safe = true;
      };
      arr[SYMBOL_ITERATOR] = function() {
        return iter;
      };
      exec(arr);
    } catch (e) {}
    return safe;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.array.of", ["npm:core-js@0.9.6/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/modules/$.def");
  $def($def.S, 'Array', {of: function of() {
      var index = 0,
          length = arguments.length,
          result = new (typeof this == 'function' ? this : Array)(length);
      while (length > index)
        result[index] = arguments[index++];
      result.length = length;
      return result;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.unscope", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      UNSCOPABLES = require("npm:core-js@0.9.6/modules/$.wks")('unscopables');
  if ($.FW && !(UNSCOPABLES in []))
    $.hide(Array.prototype, UNSCOPABLES, {});
  module.exports = function(key) {
    if ($.FW)
      [][UNSCOPABLES][key] = true;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.species", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      SPECIES = require("npm:core-js@0.9.6/modules/$.wks")('species');
  module.exports = function(C) {
    if ($.DESC && !(SPECIES in C))
      $.setDesc(C, SPECIES, {
        configurable: true,
        get: $.that
      });
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.array.copy-within", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.unscope"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      toIndex = $.toIndex;
  $def($def.P, 'Array', {copyWithin: function copyWithin(target, start) {
      var O = Object($.assertDefined(this)),
          len = $.toLength(O.length),
          to = toIndex(target, len),
          from = toIndex(start, len),
          end = arguments[2],
          fin = end === undefined ? len : toIndex(end, len),
          count = Math.min(fin - from, len - to),
          inc = 1;
      if (from < to && to < from + count) {
        inc = -1;
        from = from + count - 1;
        to = to + count - 1;
      }
      while (count-- > 0) {
        if (from in O)
          O[to] = O[from];
        else
          delete O[to];
        to += inc;
        from += inc;
      }
      return O;
    }});
  require("npm:core-js@0.9.6/modules/$.unscope")('copyWithin');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.array.fill", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.unscope"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      toIndex = $.toIndex;
  $def($def.P, 'Array', {fill: function fill(value) {
      var O = Object($.assertDefined(this)),
          length = $.toLength(O.length),
          index = toIndex(arguments[1], length),
          end = arguments[2],
          endPos = end === undefined ? length : toIndex(end, length);
      while (endPos > index)
        O[index++] = value;
      return O;
    }});
  require("npm:core-js@0.9.6/modules/$.unscope")('fill');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.array.find", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.array-methods", "npm:core-js@0.9.6/modules/$.unscope"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var KEY = 'find',
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      forced = true,
      $find = require("npm:core-js@0.9.6/modules/$.array-methods")(5);
  if (KEY in [])
    Array(1)[KEY](function() {
      forced = false;
    });
  $def($def.P + $def.F * forced, 'Array', {find: function find(callbackfn) {
      return $find(this, callbackfn, arguments[1]);
    }});
  require("npm:core-js@0.9.6/modules/$.unscope")(KEY);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.array.find-index", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.array-methods", "npm:core-js@0.9.6/modules/$.unscope"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var KEY = 'findIndex',
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      forced = true,
      $find = require("npm:core-js@0.9.6/modules/$.array-methods")(6);
  if (KEY in [])
    Array(1)[KEY](function() {
      forced = false;
    });
  $def($def.P + $def.F * forced, 'Array', {findIndex: function findIndex(callbackfn) {
      return $find(this, callbackfn, arguments[1]);
    }});
  require("npm:core-js@0.9.6/modules/$.unscope")(KEY);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.regexp", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.cof", "npm:core-js@0.9.6/modules/$.replacer", "npm:core-js@0.9.6/modules/$.species"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      cof = require("npm:core-js@0.9.6/modules/$.cof"),
      $RegExp = $.g.RegExp,
      Base = $RegExp,
      proto = $RegExp.prototype,
      re = /a/g,
      CORRECT_NEW = new $RegExp(re) !== re,
      ALLOWS_RE_WITH_FLAGS = function() {
        try {
          return $RegExp(re, 'i') == '/a/i';
        } catch (e) {}
      }();
  if ($.FW && $.DESC) {
    if (!CORRECT_NEW || !ALLOWS_RE_WITH_FLAGS) {
      $RegExp = function RegExp(pattern, flags) {
        var patternIsRegExp = cof(pattern) == 'RegExp',
            flagsIsUndefined = flags === undefined;
        if (!(this instanceof $RegExp) && patternIsRegExp && flagsIsUndefined)
          return pattern;
        return CORRECT_NEW ? new Base(patternIsRegExp && !flagsIsUndefined ? pattern.source : pattern, flags) : new Base(patternIsRegExp ? pattern.source : pattern, patternIsRegExp && flagsIsUndefined ? pattern.flags : flags);
      };
      $.each.call($.getNames(Base), function(key) {
        key in $RegExp || $.setDesc($RegExp, key, {
          configurable: true,
          get: function() {
            return Base[key];
          },
          set: function(it) {
            Base[key] = it;
          }
        });
      });
      proto.constructor = $RegExp;
      $RegExp.prototype = proto;
      $.hide($.g, 'RegExp', $RegExp);
    }
    if (/./g.flags != 'g')
      $.setDesc(proto, 'flags', {
        configurable: true,
        get: require("npm:core-js@0.9.6/modules/$.replacer")(/^.*\/(\w*)$/, '$1')
      });
  }
  require("npm:core-js@0.9.6/modules/$.species")($RegExp);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.for-of", ["npm:core-js@0.9.6/modules/$.ctx", "npm:core-js@0.9.6/modules/$.iter", "npm:core-js@0.9.6/modules/$.iter-call"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var ctx = require("npm:core-js@0.9.6/modules/$.ctx"),
      get = require("npm:core-js@0.9.6/modules/$.iter").get,
      call = require("npm:core-js@0.9.6/modules/$.iter-call");
  module.exports = function(iterable, entries, fn, that) {
    var iterator = get(iterable),
        f = ctx(fn, that, entries ? 2 : 1),
        step;
    while (!(step = iterator.next()).done) {
      if (call(iterator, f, step.value, entries) === false) {
        return call.close(iterator);
      }
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.task", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.ctx", "npm:core-js@0.9.6/modules/$.cof", "npm:core-js@0.9.6/modules/$.invoke", "npm:core-js@0.9.6/modules/$.dom-create", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var $ = require("npm:core-js@0.9.6/modules/$"),
        ctx = require("npm:core-js@0.9.6/modules/$.ctx"),
        cof = require("npm:core-js@0.9.6/modules/$.cof"),
        invoke = require("npm:core-js@0.9.6/modules/$.invoke"),
        cel = require("npm:core-js@0.9.6/modules/$.dom-create"),
        global = $.g,
        isFunction = $.isFunction,
        html = $.html,
        process = global.process,
        setTask = global.setImmediate,
        clearTask = global.clearImmediate,
        postMessage = global.postMessage,
        addEventListener = global.addEventListener,
        MessageChannel = global.MessageChannel,
        counter = 0,
        queue = {},
        ONREADYSTATECHANGE = 'onreadystatechange',
        defer,
        channel,
        port;
    function run() {
      var id = +this;
      if ($.has(queue, id)) {
        var fn = queue[id];
        delete queue[id];
        fn();
      }
    }
    function listner(event) {
      run.call(event.data);
    }
    if (!isFunction(setTask) || !isFunction(clearTask)) {
      setTask = function(fn) {
        var args = [],
            i = 1;
        while (arguments.length > i)
          args.push(arguments[i++]);
        queue[++counter] = function() {
          invoke(isFunction(fn) ? fn : Function(fn), args);
        };
        defer(counter);
        return counter;
      };
      clearTask = function(id) {
        delete queue[id];
      };
      if (cof(process) == 'process') {
        defer = function(id) {
          process.nextTick(ctx(run, id, 1));
        };
      } else if (addEventListener && isFunction(postMessage) && !global.importScripts) {
        defer = function(id) {
          postMessage(id, '*');
        };
        addEventListener('message', listner, false);
      } else if (isFunction(MessageChannel)) {
        channel = new MessageChannel;
        port = channel.port2;
        channel.port1.onmessage = listner;
        defer = ctx(port.postMessage, port, 1);
      } else if (ONREADYSTATECHANGE in cel('script')) {
        defer = function(id) {
          html.appendChild(cel('script'))[ONREADYSTATECHANGE] = function() {
            html.removeChild(this);
            run.call(id);
          };
        };
      } else {
        defer = function(id) {
          setTimeout(ctx(run, id, 1), 0);
        };
      }
    }
    module.exports = {
      set: setTask,
      clear: clearTask
    };
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.collection-strong", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.ctx", "npm:core-js@0.9.6/modules/$.uid", "npm:core-js@0.9.6/modules/$.assert", "npm:core-js@0.9.6/modules/$.for-of", "npm:core-js@0.9.6/modules/$.iter", "npm:core-js@0.9.6/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      ctx = require("npm:core-js@0.9.6/modules/$.ctx"),
      safe = require("npm:core-js@0.9.6/modules/$.uid").safe,
      assert = require("npm:core-js@0.9.6/modules/$.assert"),
      forOf = require("npm:core-js@0.9.6/modules/$.for-of"),
      step = require("npm:core-js@0.9.6/modules/$.iter").step,
      has = $.has,
      set = $.set,
      isObject = $.isObject,
      hide = $.hide,
      isFrozen = Object.isFrozen || $.core.Object.isFrozen,
      ID = safe('id'),
      O1 = safe('O1'),
      LAST = safe('last'),
      FIRST = safe('first'),
      ITER = safe('iter'),
      SIZE = $.DESC ? safe('size') : 'size',
      id = 0;
  function fastKey(it, create) {
    if (!isObject(it))
      return (typeof it == 'string' ? 'S' : 'P') + it;
    if (isFrozen(it))
      return 'F';
    if (!has(it, ID)) {
      if (!create)
        return 'E';
      hide(it, ID, ++id);
    }
    return 'O' + it[ID];
  }
  function getEntry(that, key) {
    var index = fastKey(key),
        entry;
    if (index != 'F')
      return that[O1][index];
    for (entry = that[FIRST]; entry; entry = entry.n) {
      if (entry.k == key)
        return entry;
    }
  }
  module.exports = {
    getConstructor: function(NAME, IS_MAP, ADDER) {
      function C() {
        var that = assert.inst(this, C, NAME),
            iterable = arguments[0];
        set(that, O1, $.create(null));
        set(that, SIZE, 0);
        set(that, LAST, undefined);
        set(that, FIRST, undefined);
        if (iterable != undefined)
          forOf(iterable, IS_MAP, that[ADDER], that);
      }
      $.mix(C.prototype, {
        clear: function clear() {
          for (var that = this,
              data = that[O1],
              entry = that[FIRST]; entry; entry = entry.n) {
            entry.r = true;
            if (entry.p)
              entry.p = entry.p.n = undefined;
            delete data[entry.i];
          }
          that[FIRST] = that[LAST] = undefined;
          that[SIZE] = 0;
        },
        'delete': function(key) {
          var that = this,
              entry = getEntry(that, key);
          if (entry) {
            var next = entry.n,
                prev = entry.p;
            delete that[O1][entry.i];
            entry.r = true;
            if (prev)
              prev.n = next;
            if (next)
              next.p = prev;
            if (that[FIRST] == entry)
              that[FIRST] = next;
            if (that[LAST] == entry)
              that[LAST] = prev;
            that[SIZE]--;
          }
          return !!entry;
        },
        forEach: function forEach(callbackfn) {
          var f = ctx(callbackfn, arguments[1], 3),
              entry;
          while (entry = entry ? entry.n : this[FIRST]) {
            f(entry.v, entry.k, this);
            while (entry && entry.r)
              entry = entry.p;
          }
        },
        has: function has(key) {
          return !!getEntry(this, key);
        }
      });
      if ($.DESC)
        $.setDesc(C.prototype, 'size', {get: function() {
            return assert.def(this[SIZE]);
          }});
      return C;
    },
    def: function(that, key, value) {
      var entry = getEntry(that, key),
          prev,
          index;
      if (entry) {
        entry.v = value;
      } else {
        that[LAST] = entry = {
          i: index = fastKey(key, true),
          k: key,
          v: value,
          p: prev = that[LAST],
          n: undefined,
          r: false
        };
        if (!that[FIRST])
          that[FIRST] = entry;
        if (prev)
          prev.n = entry;
        that[SIZE]++;
        if (index != 'F')
          that[O1][index] = entry;
      }
      return that;
    },
    getEntry: getEntry,
    setIter: function(C, NAME, IS_MAP) {
      require("npm:core-js@0.9.6/modules/$.iter-define")(C, NAME, function(iterated, kind) {
        set(this, ITER, {
          o: iterated,
          k: kind
        });
      }, function() {
        var iter = this[ITER],
            kind = iter.k,
            entry = iter.l;
        while (entry && entry.r)
          entry = entry.p;
        if (!iter.o || !(iter.l = entry = entry ? entry.n : iter.o[FIRST])) {
          iter.o = undefined;
          return step(1);
        }
        if (kind == 'keys')
          return step(0, entry.k);
        if (kind == 'values')
          return step(0, entry.v);
        return step(0, [entry.k, entry.v]);
      }, IS_MAP ? 'entries' : 'values', !IS_MAP, true);
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.collection", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.iter", "npm:core-js@0.9.6/modules/$.for-of", "npm:core-js@0.9.6/modules/$.species", "npm:core-js@0.9.6/modules/$.assert", "npm:core-js@0.9.6/modules/$.iter-detect", "npm:core-js@0.9.6/modules/$.cof"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      BUGGY = require("npm:core-js@0.9.6/modules/$.iter").BUGGY,
      forOf = require("npm:core-js@0.9.6/modules/$.for-of"),
      species = require("npm:core-js@0.9.6/modules/$.species"),
      assertInstance = require("npm:core-js@0.9.6/modules/$.assert").inst;
  module.exports = function(NAME, methods, common, IS_MAP, IS_WEAK) {
    var Base = $.g[NAME],
        C = Base,
        ADDER = IS_MAP ? 'set' : 'add',
        proto = C && C.prototype,
        O = {};
    function fixMethod(KEY, CHAIN) {
      var method = proto[KEY];
      if ($.FW)
        proto[KEY] = function(a, b) {
          var result = method.call(this, a === 0 ? 0 : a, b);
          return CHAIN ? this : result;
        };
    }
    if (!$.isFunction(C) || !(IS_WEAK || !BUGGY && proto.forEach && proto.entries)) {
      C = common.getConstructor(NAME, IS_MAP, ADDER);
      $.mix(C.prototype, methods);
    } else {
      var inst = new C,
          chain = inst[ADDER](IS_WEAK ? {} : -0, 1),
          buggyZero;
      if (!require("npm:core-js@0.9.6/modules/$.iter-detect")(function(iter) {
        new C(iter);
      })) {
        C = function() {
          assertInstance(this, C, NAME);
          var that = new Base,
              iterable = arguments[0];
          if (iterable != undefined)
            forOf(iterable, IS_MAP, that[ADDER], that);
          return that;
        };
        C.prototype = proto;
        if ($.FW)
          proto.constructor = C;
      }
      IS_WEAK || inst.forEach(function(val, key) {
        buggyZero = 1 / key === -Infinity;
      });
      if (buggyZero) {
        fixMethod('delete');
        fixMethod('has');
        IS_MAP && fixMethod('get');
      }
      if (buggyZero || chain !== inst)
        fixMethod(ADDER, true);
    }
    require("npm:core-js@0.9.6/modules/$.cof").set(C, NAME);
    O[NAME] = C;
    $def($def.G + $def.W + $def.F * (C != Base), O);
    species(C);
    species($.core[NAME]);
    if (!IS_WEAK)
      common.setIter(C, NAME, IS_MAP);
    return C;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.set", ["npm:core-js@0.9.6/modules/$.collection-strong", "npm:core-js@0.9.6/modules/$.collection"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var strong = require("npm:core-js@0.9.6/modules/$.collection-strong");
  require("npm:core-js@0.9.6/modules/$.collection")('Set', {add: function add(value) {
      return strong.def(this, value = value === 0 ? 0 : value, value);
    }}, strong);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.collection-weak", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.uid", "npm:core-js@0.9.6/modules/$.assert", "npm:core-js@0.9.6/modules/$.for-of", "npm:core-js@0.9.6/modules/$.array-methods"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      safe = require("npm:core-js@0.9.6/modules/$.uid").safe,
      assert = require("npm:core-js@0.9.6/modules/$.assert"),
      forOf = require("npm:core-js@0.9.6/modules/$.for-of"),
      _has = $.has,
      isObject = $.isObject,
      hide = $.hide,
      isFrozen = Object.isFrozen || $.core.Object.isFrozen,
      id = 0,
      ID = safe('id'),
      WEAK = safe('weak'),
      LEAK = safe('leak'),
      method = require("npm:core-js@0.9.6/modules/$.array-methods"),
      find = method(5),
      findIndex = method(6);
  function findFrozen(store, key) {
    return find(store.array, function(it) {
      return it[0] === key;
    });
  }
  function leakStore(that) {
    return that[LEAK] || hide(that, LEAK, {
      array: [],
      get: function(key) {
        var entry = findFrozen(this, key);
        if (entry)
          return entry[1];
      },
      has: function(key) {
        return !!findFrozen(this, key);
      },
      set: function(key, value) {
        var entry = findFrozen(this, key);
        if (entry)
          entry[1] = value;
        else
          this.array.push([key, value]);
      },
      'delete': function(key) {
        var index = findIndex(this.array, function(it) {
          return it[0] === key;
        });
        if (~index)
          this.array.splice(index, 1);
        return !!~index;
      }
    })[LEAK];
  }
  module.exports = {
    getConstructor: function(NAME, IS_MAP, ADDER) {
      function C() {
        $.set(assert.inst(this, C, NAME), ID, id++);
        var iterable = arguments[0];
        if (iterable != undefined)
          forOf(iterable, IS_MAP, this[ADDER], this);
      }
      $.mix(C.prototype, {
        'delete': function(key) {
          if (!isObject(key))
            return false;
          if (isFrozen(key))
            return leakStore(this)['delete'](key);
          return _has(key, WEAK) && _has(key[WEAK], this[ID]) && delete key[WEAK][this[ID]];
        },
        has: function has(key) {
          if (!isObject(key))
            return false;
          if (isFrozen(key))
            return leakStore(this).has(key);
          return _has(key, WEAK) && _has(key[WEAK], this[ID]);
        }
      });
      return C;
    },
    def: function(that, key, value) {
      if (isFrozen(assert.obj(key))) {
        leakStore(that).set(key, value);
      } else {
        _has(key, WEAK) || hide(key, WEAK, {});
        key[WEAK][that[ID]] = value;
      }
      return that;
    },
    leakStore: leakStore,
    WEAK: WEAK,
    ID: ID
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.weak-set", ["npm:core-js@0.9.6/modules/$.collection-weak", "npm:core-js@0.9.6/modules/$.collection"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var weak = require("npm:core-js@0.9.6/modules/$.collection-weak");
  require("npm:core-js@0.9.6/modules/$.collection")('WeakSet', {add: function add(value) {
      return weak.def(this, value, true);
    }}, weak, false, true);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.own-keys", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      assertObject = require("npm:core-js@0.9.6/modules/$.assert").obj;
  module.exports = function ownKeys(it) {
    assertObject(it);
    var keys = $.getNames(it),
        getSymbols = $.getSymbols;
    return getSymbols ? keys.concat(getSymbols(it)) : keys;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es7.array.includes", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.array-includes", "npm:core-js@0.9.6/modules/$.unscope"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/modules/$.def"),
      $includes = require("npm:core-js@0.9.6/modules/$.array-includes")(true);
  $def($def.P, 'Array', {includes: function includes(el) {
      return $includes(this, el, arguments[1]);
    }});
  require("npm:core-js@0.9.6/modules/$.unscope")('includes');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es7.string.at", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.string-at"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $def = require("npm:core-js@0.9.6/modules/$.def"),
      $at = require("npm:core-js@0.9.6/modules/$.string-at")(true);
  $def($def.P, 'String', {at: function at(pos) {
      return $at(this, pos);
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.string-pad", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.string-repeat"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      repeat = require("npm:core-js@0.9.6/modules/$.string-repeat");
  module.exports = function(that, minLength, fillChar, left) {
    var S = String($.assertDefined(that));
    if (minLength === undefined)
      return S;
    var intMinLength = $.toInteger(minLength);
    var fillLen = intMinLength - S.length;
    if (fillLen < 0 || fillLen === Infinity) {
      throw new RangeError('Cannot satisfy string length ' + minLength + ' for string: ' + S);
    }
    var sFillStr = fillChar === undefined ? ' ' : String(fillChar);
    var sFillVal = repeat.call(sFillStr, Math.ceil(fillLen / sFillStr.length));
    if (sFillVal.length > fillLen)
      sFillVal = left ? sFillVal.slice(sFillVal.length - fillLen) : sFillVal.slice(0, fillLen);
    return left ? sFillVal.concat(S) : S.concat(sFillVal);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es7.string.rpad", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.string-pad"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $def = require("npm:core-js@0.9.6/modules/$.def"),
      $pad = require("npm:core-js@0.9.6/modules/$.string-pad");
  $def($def.P, 'String', {rpad: function rpad(n) {
      return $pad(this, n, arguments[1], false);
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es7.regexp.escape", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.replacer"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/modules/$.def");
  $def($def.S, 'RegExp', {escape: require("npm:core-js@0.9.6/modules/$.replacer")(/([\\\-[\]{}()*+?.,^$|])/g, '\\$1', true)});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es7.object.get-own-property-descriptors", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.own-keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      ownKeys = require("npm:core-js@0.9.6/modules/$.own-keys");
  $def($def.S, 'Object', {getOwnPropertyDescriptors: function getOwnPropertyDescriptors(object) {
      var O = $.toObject(object),
          result = {};
      $.each.call(ownKeys(O), function(key) {
        $.setDesc(result, key, $.desc(0, $.getDesc(O, key)));
      });
      return result;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es7.object.to-array", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.def"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      $def = require("npm:core-js@0.9.6/modules/$.def");
  function createObjectToArray(isEntries) {
    return function(object) {
      var O = $.toObject(object),
          keys = $.getKeys(O),
          length = keys.length,
          i = 0,
          result = Array(length),
          key;
      if (isEntries)
        while (length > i)
          result[i] = [key = keys[i++], O[key]];
      else
        while (length > i)
          result[i] = O[keys[i++]];
      return result;
    };
  }
  $def($def.S, 'Object', {
    values: createObjectToArray(false),
    entries: createObjectToArray(true)
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.collection-to-json", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.for-of"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/modules/$.def"),
      forOf = require("npm:core-js@0.9.6/modules/$.for-of");
  module.exports = function(NAME) {
    $def($def.P, NAME, {toJSON: function toJSON() {
        var arr = [];
        forOf(this, false, arr.push, arr);
        return arr;
      }});
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es7.set.to-json", ["npm:core-js@0.9.6/modules/$.collection-to-json"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/modules/$.collection-to-json")('Set');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/js.array.statics", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.ctx"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      $Array = $.core.Array || Array,
      statics = {};
  function setStatics(keys, length) {
    $.each.call(keys.split(','), function(key) {
      if (length == undefined && key in $Array)
        statics[key] = $Array[key];
      else if (key in [])
        statics[key] = require("npm:core-js@0.9.6/modules/$.ctx")(Function.call, [][key], length);
    });
  }
  setStatics('pop,reverse,shift,keys,values,entries', 1);
  setStatics('indexOf,every,some,forEach,map,filter,find,findIndex,includes', 3);
  setStatics('join,slice,concat,push,splice,unshift,sort,lastIndexOf,' + 'reduce,reduceRight,copyWithin,fill,turn');
  $def($def.S, 'Array', statics);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.partial", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.invoke", "npm:core-js@0.9.6/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      invoke = require("npm:core-js@0.9.6/modules/$.invoke"),
      assertFunction = require("npm:core-js@0.9.6/modules/$.assert").fn;
  module.exports = function() {
    var fn = assertFunction(this),
        length = arguments.length,
        pargs = Array(length),
        i = 0,
        _ = $.path._,
        holder = false;
    while (length > i)
      if ((pargs[i] = arguments[i++]) === _)
        holder = true;
    return function() {
      var that = this,
          _length = arguments.length,
          j = 0,
          k = 0,
          args;
      if (!holder && !_length)
        return invoke(fn, pargs, that);
      args = pargs.slice();
      if (holder)
        for (; length > j; j++)
          if (args[j] === _)
            args[j] = arguments[k++];
      while (_length > k)
        args.push(arguments[k++]);
      return invoke(fn, args, that);
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/web.immediate", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.task"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/modules/$.def"),
      $task = require("npm:core-js@0.9.6/modules/$.task");
  $def($def.G + $def.B, {
    setImmediate: $task.set,
    clearImmediate: $task.clear
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/web.dom.iterable", ["npm:core-js@0.9.6/modules/es6.array.iterator", "npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.iter", "npm:core-js@0.9.6/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/modules/es6.array.iterator");
  var $ = require("npm:core-js@0.9.6/modules/$"),
      Iterators = require("npm:core-js@0.9.6/modules/$.iter").Iterators,
      ITERATOR = require("npm:core-js@0.9.6/modules/$.wks")('iterator'),
      ArrayValues = Iterators.Array,
      NodeList = $.g.NodeList;
  if ($.FW && NodeList && !(ITERATOR in NodeList.prototype)) {
    $.hide(NodeList.prototype, ITERATOR, ArrayValues);
  }
  Iterators.NodeList = ArrayValues;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.keyof", ["npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$");
  module.exports = function(object, el) {
    var O = $.toObject(object),
        keys = $.getKeys(O),
        length = keys.length,
        index = 0,
        key;
    while (length > index)
      if (O[key = keys[index++]] === el)
        return key;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.enum-keys", ["npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$");
  module.exports = function(it) {
    var keys = $.getKeys(it),
        getDesc = $.getDesc,
        getSymbols = $.getSymbols;
    if (getSymbols)
      $.each.call(getSymbols(it), function(key) {
        if (getDesc(it, key).enumerable)
          keys.push(key);
      });
    return keys;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/fn/symbol/iterator", ["npm:core-js@0.9.6/library/modules/es6.string.iterator", "npm:core-js@0.9.6/library/modules/web.dom.iterable", "npm:core-js@0.9.6/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/library/modules/es6.string.iterator");
  require("npm:core-js@0.9.6/library/modules/web.dom.iterable");
  module.exports = require("npm:core-js@0.9.6/library/modules/$.wks")('iterator');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/fn/object/create", ["npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$");
  module.exports = function create(P, D) {
    return $.create(P, D);
  };
  global.define = __define;
  return module.exports;
});

(function() {
function define(){};  define.amd = {};
(function(global, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = global.document ? factory(global, true) : function(w) {
      if (!w.document) {
        throw new Error("jQuery requires a window with a document");
      }
      return factory(w);
    };
  } else {
    factory(global);
  }
}(typeof window !== "undefined" ? window : this, function(window, noGlobal) {
  var arr = [];
  var slice = arr.slice;
  var concat = arr.concat;
  var push = arr.push;
  var indexOf = arr.indexOf;
  var class2type = {};
  var toString = class2type.toString;
  var hasOwn = class2type.hasOwnProperty;
  var support = {};
  var document = window.document,
      version = "2.1.3",
      jQuery = function(selector, context) {
        return new jQuery.fn.init(selector, context);
      },
      rtrim = /^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g,
      rmsPrefix = /^-ms-/,
      rdashAlpha = /-([\da-z])/gi,
      fcamelCase = function(all, letter) {
        return letter.toUpperCase();
      };
  jQuery.fn = jQuery.prototype = {
    jquery: version,
    constructor: jQuery,
    selector: "",
    length: 0,
    toArray: function() {
      return slice.call(this);
    },
    get: function(num) {
      return num != null ? (num < 0 ? this[num + this.length] : this[num]) : slice.call(this);
    },
    pushStack: function(elems) {
      var ret = jQuery.merge(this.constructor(), elems);
      ret.prevObject = this;
      ret.context = this.context;
      return ret;
    },
    each: function(callback, args) {
      return jQuery.each(this, callback, args);
    },
    map: function(callback) {
      return this.pushStack(jQuery.map(this, function(elem, i) {
        return callback.call(elem, i, elem);
      }));
    },
    slice: function() {
      return this.pushStack(slice.apply(this, arguments));
    },
    first: function() {
      return this.eq(0);
    },
    last: function() {
      return this.eq(-1);
    },
    eq: function(i) {
      var len = this.length,
          j = +i + (i < 0 ? len : 0);
      return this.pushStack(j >= 0 && j < len ? [this[j]] : []);
    },
    end: function() {
      return this.prevObject || this.constructor(null);
    },
    push: push,
    sort: arr.sort,
    splice: arr.splice
  };
  jQuery.extend = jQuery.fn.extend = function() {
    var options,
        name,
        src,
        copy,
        copyIsArray,
        clone,
        target = arguments[0] || {},
        i = 1,
        length = arguments.length,
        deep = false;
    if (typeof target === "boolean") {
      deep = target;
      target = arguments[i] || {};
      i++;
    }
    if (typeof target !== "object" && !jQuery.isFunction(target)) {
      target = {};
    }
    if (i === length) {
      target = this;
      i--;
    }
    for (; i < length; i++) {
      if ((options = arguments[i]) != null) {
        for (name in options) {
          src = target[name];
          copy = options[name];
          if (target === copy) {
            continue;
          }
          if (deep && copy && (jQuery.isPlainObject(copy) || (copyIsArray = jQuery.isArray(copy)))) {
            if (copyIsArray) {
              copyIsArray = false;
              clone = src && jQuery.isArray(src) ? src : [];
            } else {
              clone = src && jQuery.isPlainObject(src) ? src : {};
            }
            target[name] = jQuery.extend(deep, clone, copy);
          } else if (copy !== undefined) {
            target[name] = copy;
          }
        }
      }
    }
    return target;
  };
  jQuery.extend({
    expando: "jQuery" + (version + Math.random()).replace(/\D/g, ""),
    isReady: true,
    error: function(msg) {
      throw new Error(msg);
    },
    noop: function() {},
    isFunction: function(obj) {
      return jQuery.type(obj) === "function";
    },
    isArray: Array.isArray,
    isWindow: function(obj) {
      return obj != null && obj === obj.window;
    },
    isNumeric: function(obj) {
      return !jQuery.isArray(obj) && (obj - parseFloat(obj) + 1) >= 0;
    },
    isPlainObject: function(obj) {
      if (jQuery.type(obj) !== "object" || obj.nodeType || jQuery.isWindow(obj)) {
        return false;
      }
      if (obj.constructor && !hasOwn.call(obj.constructor.prototype, "isPrototypeOf")) {
        return false;
      }
      return true;
    },
    isEmptyObject: function(obj) {
      var name;
      for (name in obj) {
        return false;
      }
      return true;
    },
    type: function(obj) {
      if (obj == null) {
        return obj + "";
      }
      return typeof obj === "object" || typeof obj === "function" ? class2type[toString.call(obj)] || "object" : typeof obj;
    },
    globalEval: function(code) {
      var script,
          indirect = eval;
      code = jQuery.trim(code);
      if (code) {
        if (code.indexOf("use strict") === 1) {
          script = document.createElement("script");
          script.text = code;
          document.head.appendChild(script).parentNode.removeChild(script);
        } else {
          indirect(code);
        }
      }
    },
    camelCase: function(string) {
      return string.replace(rmsPrefix, "ms-").replace(rdashAlpha, fcamelCase);
    },
    nodeName: function(elem, name) {
      return elem.nodeName && elem.nodeName.toLowerCase() === name.toLowerCase();
    },
    each: function(obj, callback, args) {
      var value,
          i = 0,
          length = obj.length,
          isArray = isArraylike(obj);
      if (args) {
        if (isArray) {
          for (; i < length; i++) {
            value = callback.apply(obj[i], args);
            if (value === false) {
              break;
            }
          }
        } else {
          for (i in obj) {
            value = callback.apply(obj[i], args);
            if (value === false) {
              break;
            }
          }
        }
      } else {
        if (isArray) {
          for (; i < length; i++) {
            value = callback.call(obj[i], i, obj[i]);
            if (value === false) {
              break;
            }
          }
        } else {
          for (i in obj) {
            value = callback.call(obj[i], i, obj[i]);
            if (value === false) {
              break;
            }
          }
        }
      }
      return obj;
    },
    trim: function(text) {
      return text == null ? "" : (text + "").replace(rtrim, "");
    },
    makeArray: function(arr, results) {
      var ret = results || [];
      if (arr != null) {
        if (isArraylike(Object(arr))) {
          jQuery.merge(ret, typeof arr === "string" ? [arr] : arr);
        } else {
          push.call(ret, arr);
        }
      }
      return ret;
    },
    inArray: function(elem, arr, i) {
      return arr == null ? -1 : indexOf.call(arr, elem, i);
    },
    merge: function(first, second) {
      var len = +second.length,
          j = 0,
          i = first.length;
      for (; j < len; j++) {
        first[i++] = second[j];
      }
      first.length = i;
      return first;
    },
    grep: function(elems, callback, invert) {
      var callbackInverse,
          matches = [],
          i = 0,
          length = elems.length,
          callbackExpect = !invert;
      for (; i < length; i++) {
        callbackInverse = !callback(elems[i], i);
        if (callbackInverse !== callbackExpect) {
          matches.push(elems[i]);
        }
      }
      return matches;
    },
    map: function(elems, callback, arg) {
      var value,
          i = 0,
          length = elems.length,
          isArray = isArraylike(elems),
          ret = [];
      if (isArray) {
        for (; i < length; i++) {
          value = callback(elems[i], i, arg);
          if (value != null) {
            ret.push(value);
          }
        }
      } else {
        for (i in elems) {
          value = callback(elems[i], i, arg);
          if (value != null) {
            ret.push(value);
          }
        }
      }
      return concat.apply([], ret);
    },
    guid: 1,
    proxy: function(fn, context) {
      var tmp,
          args,
          proxy;
      if (typeof context === "string") {
        tmp = fn[context];
        context = fn;
        fn = tmp;
      }
      if (!jQuery.isFunction(fn)) {
        return undefined;
      }
      args = slice.call(arguments, 2);
      proxy = function() {
        return fn.apply(context || this, args.concat(slice.call(arguments)));
      };
      proxy.guid = fn.guid = fn.guid || jQuery.guid++;
      return proxy;
    },
    now: Date.now,
    support: support
  });
  jQuery.each("Boolean Number String Function Array Date RegExp Object Error".split(" "), function(i, name) {
    class2type["[object " + name + "]"] = name.toLowerCase();
  });
  function isArraylike(obj) {
    var length = obj.length,
        type = jQuery.type(obj);
    if (type === "function" || jQuery.isWindow(obj)) {
      return false;
    }
    if (obj.nodeType === 1 && length) {
      return true;
    }
    return type === "array" || length === 0 || typeof length === "number" && length > 0 && (length - 1) in obj;
  }
  var Sizzle = (function(window) {
    var i,
        support,
        Expr,
        getText,
        isXML,
        tokenize,
        compile,
        select,
        outermostContext,
        sortInput,
        hasDuplicate,
        setDocument,
        document,
        docElem,
        documentIsHTML,
        rbuggyQSA,
        rbuggyMatches,
        matches,
        contains,
        expando = "sizzle" + 1 * new Date(),
        preferredDoc = window.document,
        dirruns = 0,
        done = 0,
        classCache = createCache(),
        tokenCache = createCache(),
        compilerCache = createCache(),
        sortOrder = function(a, b) {
          if (a === b) {
            hasDuplicate = true;
          }
          return 0;
        },
        MAX_NEGATIVE = 1 << 31,
        hasOwn = ({}).hasOwnProperty,
        arr = [],
        pop = arr.pop,
        push_native = arr.push,
        push = arr.push,
        slice = arr.slice,
        indexOf = function(list, elem) {
          var i = 0,
              len = list.length;
          for (; i < len; i++) {
            if (list[i] === elem) {
              return i;
            }
          }
          return -1;
        },
        booleans = "checked|selected|async|autofocus|autoplay|controls|defer|disabled|hidden|ismap|loop|multiple|open|readonly|required|scoped",
        whitespace = "[\\x20\\t\\r\\n\\f]",
        characterEncoding = "(?:\\\\.|[\\w-]|[^\\x00-\\xa0])+",
        identifier = characterEncoding.replace("w", "w#"),
        attributes = "\\[" + whitespace + "*(" + characterEncoding + ")(?:" + whitespace + "*([*^$|!~]?=)" + whitespace + "*(?:'((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\"|(" + identifier + "))|)" + whitespace + "*\\]",
        pseudos = ":(" + characterEncoding + ")(?:\\((" + "('((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\")|" + "((?:\\\\.|[^\\\\()[\\]]|" + attributes + ")*)|" + ".*" + ")\\)|)",
        rwhitespace = new RegExp(whitespace + "+", "g"),
        rtrim = new RegExp("^" + whitespace + "+|((?:^|[^\\\\])(?:\\\\.)*)" + whitespace + "+$", "g"),
        rcomma = new RegExp("^" + whitespace + "*," + whitespace + "*"),
        rcombinators = new RegExp("^" + whitespace + "*([>+~]|" + whitespace + ")" + whitespace + "*"),
        rattributeQuotes = new RegExp("=" + whitespace + "*([^\\]'\"]*?)" + whitespace + "*\\]", "g"),
        rpseudo = new RegExp(pseudos),
        ridentifier = new RegExp("^" + identifier + "$"),
        matchExpr = {
          "ID": new RegExp("^#(" + characterEncoding + ")"),
          "CLASS": new RegExp("^\\.(" + characterEncoding + ")"),
          "TAG": new RegExp("^(" + characterEncoding.replace("w", "w*") + ")"),
          "ATTR": new RegExp("^" + attributes),
          "PSEUDO": new RegExp("^" + pseudos),
          "CHILD": new RegExp("^:(only|first|last|nth|nth-last)-(child|of-type)(?:\\(" + whitespace + "*(even|odd|(([+-]|)(\\d*)n|)" + whitespace + "*(?:([+-]|)" + whitespace + "*(\\d+)|))" + whitespace + "*\\)|)", "i"),
          "bool": new RegExp("^(?:" + booleans + ")$", "i"),
          "needsContext": new RegExp("^" + whitespace + "*[>+~]|:(even|odd|eq|gt|lt|nth|first|last)(?:\\(" + whitespace + "*((?:-\\d)?\\d*)" + whitespace + "*\\)|)(?=[^-]|$)", "i")
        },
        rinputs = /^(?:input|select|textarea|button)$/i,
        rheader = /^h\d$/i,
        rnative = /^[^{]+\{\s*\[native \w/,
        rquickExpr = /^(?:#([\w-]+)|(\w+)|\.([\w-]+))$/,
        rsibling = /[+~]/,
        rescape = /'|\\/g,
        runescape = new RegExp("\\\\([\\da-f]{1,6}" + whitespace + "?|(" + whitespace + ")|.)", "ig"),
        funescape = function(_, escaped, escapedWhitespace) {
          var high = "0x" + escaped - 0x10000;
          return high !== high || escapedWhitespace ? escaped : high < 0 ? String.fromCharCode(high + 0x10000) : String.fromCharCode(high >> 10 | 0xD800, high & 0x3FF | 0xDC00);
        },
        unloadHandler = function() {
          setDocument();
        };
    try {
      push.apply((arr = slice.call(preferredDoc.childNodes)), preferredDoc.childNodes);
      arr[preferredDoc.childNodes.length].nodeType;
    } catch (e) {
      push = {apply: arr.length ? function(target, els) {
          push_native.apply(target, slice.call(els));
        } : function(target, els) {
          var j = target.length,
              i = 0;
          while ((target[j++] = els[i++])) {}
          target.length = j - 1;
        }};
    }
    function Sizzle(selector, context, results, seed) {
      var match,
          elem,
          m,
          nodeType,
          i,
          groups,
          old,
          nid,
          newContext,
          newSelector;
      if ((context ? context.ownerDocument || context : preferredDoc) !== document) {
        setDocument(context);
      }
      context = context || document;
      results = results || [];
      nodeType = context.nodeType;
      if (typeof selector !== "string" || !selector || nodeType !== 1 && nodeType !== 9 && nodeType !== 11) {
        return results;
      }
      if (!seed && documentIsHTML) {
        if (nodeType !== 11 && (match = rquickExpr.exec(selector))) {
          if ((m = match[1])) {
            if (nodeType === 9) {
              elem = context.getElementById(m);
              if (elem && elem.parentNode) {
                if (elem.id === m) {
                  results.push(elem);
                  return results;
                }
              } else {
                return results;
              }
            } else {
              if (context.ownerDocument && (elem = context.ownerDocument.getElementById(m)) && contains(context, elem) && elem.id === m) {
                results.push(elem);
                return results;
              }
            }
          } else if (match[2]) {
            push.apply(results, context.getElementsByTagName(selector));
            return results;
          } else if ((m = match[3]) && support.getElementsByClassName) {
            push.apply(results, context.getElementsByClassName(m));
            return results;
          }
        }
        if (support.qsa && (!rbuggyQSA || !rbuggyQSA.test(selector))) {
          nid = old = expando;
          newContext = context;
          newSelector = nodeType !== 1 && selector;
          if (nodeType === 1 && context.nodeName.toLowerCase() !== "object") {
            groups = tokenize(selector);
            if ((old = context.getAttribute("id"))) {
              nid = old.replace(rescape, "\\$&");
            } else {
              context.setAttribute("id", nid);
            }
            nid = "[id='" + nid + "'] ";
            i = groups.length;
            while (i--) {
              groups[i] = nid + toSelector(groups[i]);
            }
            newContext = rsibling.test(selector) && testContext(context.parentNode) || context;
            newSelector = groups.join(",");
          }
          if (newSelector) {
            try {
              push.apply(results, newContext.querySelectorAll(newSelector));
              return results;
            } catch (qsaError) {} finally {
              if (!old) {
                context.removeAttribute("id");
              }
            }
          }
        }
      }
      return select(selector.replace(rtrim, "$1"), context, results, seed);
    }
    function createCache() {
      var keys = [];
      function cache(key, value) {
        if (keys.push(key + " ") > Expr.cacheLength) {
          delete cache[keys.shift()];
        }
        return (cache[key + " "] = value);
      }
      return cache;
    }
    function markFunction(fn) {
      fn[expando] = true;
      return fn;
    }
    function assert(fn) {
      var div = document.createElement("div");
      try {
        return !!fn(div);
      } catch (e) {
        return false;
      } finally {
        if (div.parentNode) {
          div.parentNode.removeChild(div);
        }
        div = null;
      }
    }
    function addHandle(attrs, handler) {
      var arr = attrs.split("|"),
          i = attrs.length;
      while (i--) {
        Expr.attrHandle[arr[i]] = handler;
      }
    }
    function siblingCheck(a, b) {
      var cur = b && a,
          diff = cur && a.nodeType === 1 && b.nodeType === 1 && (~b.sourceIndex || MAX_NEGATIVE) - (~a.sourceIndex || MAX_NEGATIVE);
      if (diff) {
        return diff;
      }
      if (cur) {
        while ((cur = cur.nextSibling)) {
          if (cur === b) {
            return -1;
          }
        }
      }
      return a ? 1 : -1;
    }
    function createInputPseudo(type) {
      return function(elem) {
        var name = elem.nodeName.toLowerCase();
        return name === "input" && elem.type === type;
      };
    }
    function createButtonPseudo(type) {
      return function(elem) {
        var name = elem.nodeName.toLowerCase();
        return (name === "input" || name === "button") && elem.type === type;
      };
    }
    function createPositionalPseudo(fn) {
      return markFunction(function(argument) {
        argument = +argument;
        return markFunction(function(seed, matches) {
          var j,
              matchIndexes = fn([], seed.length, argument),
              i = matchIndexes.length;
          while (i--) {
            if (seed[(j = matchIndexes[i])]) {
              seed[j] = !(matches[j] = seed[j]);
            }
          }
        });
      });
    }
    function testContext(context) {
      return context && typeof context.getElementsByTagName !== "undefined" && context;
    }
    support = Sizzle.support = {};
    isXML = Sizzle.isXML = function(elem) {
      var documentElement = elem && (elem.ownerDocument || elem).documentElement;
      return documentElement ? documentElement.nodeName !== "HTML" : false;
    };
    setDocument = Sizzle.setDocument = function(node) {
      var hasCompare,
          parent,
          doc = node ? node.ownerDocument || node : preferredDoc;
      if (doc === document || doc.nodeType !== 9 || !doc.documentElement) {
        return document;
      }
      document = doc;
      docElem = doc.documentElement;
      parent = doc.defaultView;
      if (parent && parent !== parent.top) {
        if (parent.addEventListener) {
          parent.addEventListener("unload", unloadHandler, false);
        } else if (parent.attachEvent) {
          parent.attachEvent("onunload", unloadHandler);
        }
      }
      documentIsHTML = !isXML(doc);
      support.attributes = assert(function(div) {
        div.className = "i";
        return !div.getAttribute("className");
      });
      support.getElementsByTagName = assert(function(div) {
        div.appendChild(doc.createComment(""));
        return !div.getElementsByTagName("*").length;
      });
      support.getElementsByClassName = rnative.test(doc.getElementsByClassName);
      support.getById = assert(function(div) {
        docElem.appendChild(div).id = expando;
        return !doc.getElementsByName || !doc.getElementsByName(expando).length;
      });
      if (support.getById) {
        Expr.find["ID"] = function(id, context) {
          if (typeof context.getElementById !== "undefined" && documentIsHTML) {
            var m = context.getElementById(id);
            return m && m.parentNode ? [m] : [];
          }
        };
        Expr.filter["ID"] = function(id) {
          var attrId = id.replace(runescape, funescape);
          return function(elem) {
            return elem.getAttribute("id") === attrId;
          };
        };
      } else {
        delete Expr.find["ID"];
        Expr.filter["ID"] = function(id) {
          var attrId = id.replace(runescape, funescape);
          return function(elem) {
            var node = typeof elem.getAttributeNode !== "undefined" && elem.getAttributeNode("id");
            return node && node.value === attrId;
          };
        };
      }
      Expr.find["TAG"] = support.getElementsByTagName ? function(tag, context) {
        if (typeof context.getElementsByTagName !== "undefined") {
          return context.getElementsByTagName(tag);
        } else if (support.qsa) {
          return context.querySelectorAll(tag);
        }
      } : function(tag, context) {
        var elem,
            tmp = [],
            i = 0,
            results = context.getElementsByTagName(tag);
        if (tag === "*") {
          while ((elem = results[i++])) {
            if (elem.nodeType === 1) {
              tmp.push(elem);
            }
          }
          return tmp;
        }
        return results;
      };
      Expr.find["CLASS"] = support.getElementsByClassName && function(className, context) {
        if (documentIsHTML) {
          return context.getElementsByClassName(className);
        }
      };
      rbuggyMatches = [];
      rbuggyQSA = [];
      if ((support.qsa = rnative.test(doc.querySelectorAll))) {
        assert(function(div) {
          docElem.appendChild(div).innerHTML = "<a id='" + expando + "'></a>" + "<select id='" + expando + "-\f]' msallowcapture=''>" + "<option selected=''></option></select>";
          if (div.querySelectorAll("[msallowcapture^='']").length) {
            rbuggyQSA.push("[*^$]=" + whitespace + "*(?:''|\"\")");
          }
          if (!div.querySelectorAll("[selected]").length) {
            rbuggyQSA.push("\\[" + whitespace + "*(?:value|" + booleans + ")");
          }
          if (!div.querySelectorAll("[id~=" + expando + "-]").length) {
            rbuggyQSA.push("~=");
          }
          if (!div.querySelectorAll(":checked").length) {
            rbuggyQSA.push(":checked");
          }
          if (!div.querySelectorAll("a#" + expando + "+*").length) {
            rbuggyQSA.push(".#.+[+~]");
          }
        });
        assert(function(div) {
          var input = doc.createElement("input");
          input.setAttribute("type", "hidden");
          div.appendChild(input).setAttribute("name", "D");
          if (div.querySelectorAll("[name=d]").length) {
            rbuggyQSA.push("name" + whitespace + "*[*^$|!~]?=");
          }
          if (!div.querySelectorAll(":enabled").length) {
            rbuggyQSA.push(":enabled", ":disabled");
          }
          div.querySelectorAll("*,:x");
          rbuggyQSA.push(",.*:");
        });
      }
      if ((support.matchesSelector = rnative.test((matches = docElem.matches || docElem.webkitMatchesSelector || docElem.mozMatchesSelector || docElem.oMatchesSelector || docElem.msMatchesSelector)))) {
        assert(function(div) {
          support.disconnectedMatch = matches.call(div, "div");
          matches.call(div, "[s!='']:x");
          rbuggyMatches.push("!=", pseudos);
        });
      }
      rbuggyQSA = rbuggyQSA.length && new RegExp(rbuggyQSA.join("|"));
      rbuggyMatches = rbuggyMatches.length && new RegExp(rbuggyMatches.join("|"));
      hasCompare = rnative.test(docElem.compareDocumentPosition);
      contains = hasCompare || rnative.test(docElem.contains) ? function(a, b) {
        var adown = a.nodeType === 9 ? a.documentElement : a,
            bup = b && b.parentNode;
        return a === bup || !!(bup && bup.nodeType === 1 && (adown.contains ? adown.contains(bup) : a.compareDocumentPosition && a.compareDocumentPosition(bup) & 16));
      } : function(a, b) {
        if (b) {
          while ((b = b.parentNode)) {
            if (b === a) {
              return true;
            }
          }
        }
        return false;
      };
      sortOrder = hasCompare ? function(a, b) {
        if (a === b) {
          hasDuplicate = true;
          return 0;
        }
        var compare = !a.compareDocumentPosition - !b.compareDocumentPosition;
        if (compare) {
          return compare;
        }
        compare = (a.ownerDocument || a) === (b.ownerDocument || b) ? a.compareDocumentPosition(b) : 1;
        if (compare & 1 || (!support.sortDetached && b.compareDocumentPosition(a) === compare)) {
          if (a === doc || a.ownerDocument === preferredDoc && contains(preferredDoc, a)) {
            return -1;
          }
          if (b === doc || b.ownerDocument === preferredDoc && contains(preferredDoc, b)) {
            return 1;
          }
          return sortInput ? (indexOf(sortInput, a) - indexOf(sortInput, b)) : 0;
        }
        return compare & 4 ? -1 : 1;
      } : function(a, b) {
        if (a === b) {
          hasDuplicate = true;
          return 0;
        }
        var cur,
            i = 0,
            aup = a.parentNode,
            bup = b.parentNode,
            ap = [a],
            bp = [b];
        if (!aup || !bup) {
          return a === doc ? -1 : b === doc ? 1 : aup ? -1 : bup ? 1 : sortInput ? (indexOf(sortInput, a) - indexOf(sortInput, b)) : 0;
        } else if (aup === bup) {
          return siblingCheck(a, b);
        }
        cur = a;
        while ((cur = cur.parentNode)) {
          ap.unshift(cur);
        }
        cur = b;
        while ((cur = cur.parentNode)) {
          bp.unshift(cur);
        }
        while (ap[i] === bp[i]) {
          i++;
        }
        return i ? siblingCheck(ap[i], bp[i]) : ap[i] === preferredDoc ? -1 : bp[i] === preferredDoc ? 1 : 0;
      };
      return doc;
    };
    Sizzle.matches = function(expr, elements) {
      return Sizzle(expr, null, null, elements);
    };
    Sizzle.matchesSelector = function(elem, expr) {
      if ((elem.ownerDocument || elem) !== document) {
        setDocument(elem);
      }
      expr = expr.replace(rattributeQuotes, "='$1']");
      if (support.matchesSelector && documentIsHTML && (!rbuggyMatches || !rbuggyMatches.test(expr)) && (!rbuggyQSA || !rbuggyQSA.test(expr))) {
        try {
          var ret = matches.call(elem, expr);
          if (ret || support.disconnectedMatch || elem.document && elem.document.nodeType !== 11) {
            return ret;
          }
        } catch (e) {}
      }
      return Sizzle(expr, document, null, [elem]).length > 0;
    };
    Sizzle.contains = function(context, elem) {
      if ((context.ownerDocument || context) !== document) {
        setDocument(context);
      }
      return contains(context, elem);
    };
    Sizzle.attr = function(elem, name) {
      if ((elem.ownerDocument || elem) !== document) {
        setDocument(elem);
      }
      var fn = Expr.attrHandle[name.toLowerCase()],
          val = fn && hasOwn.call(Expr.attrHandle, name.toLowerCase()) ? fn(elem, name, !documentIsHTML) : undefined;
      return val !== undefined ? val : support.attributes || !documentIsHTML ? elem.getAttribute(name) : (val = elem.getAttributeNode(name)) && val.specified ? val.value : null;
    };
    Sizzle.error = function(msg) {
      throw new Error("Syntax error, unrecognized expression: " + msg);
    };
    Sizzle.uniqueSort = function(results) {
      var elem,
          duplicates = [],
          j = 0,
          i = 0;
      hasDuplicate = !support.detectDuplicates;
      sortInput = !support.sortStable && results.slice(0);
      results.sort(sortOrder);
      if (hasDuplicate) {
        while ((elem = results[i++])) {
          if (elem === results[i]) {
            j = duplicates.push(i);
          }
        }
        while (j--) {
          results.splice(duplicates[j], 1);
        }
      }
      sortInput = null;
      return results;
    };
    getText = Sizzle.getText = function(elem) {
      var node,
          ret = "",
          i = 0,
          nodeType = elem.nodeType;
      if (!nodeType) {
        while ((node = elem[i++])) {
          ret += getText(node);
        }
      } else if (nodeType === 1 || nodeType === 9 || nodeType === 11) {
        if (typeof elem.textContent === "string") {
          return elem.textContent;
        } else {
          for (elem = elem.firstChild; elem; elem = elem.nextSibling) {
            ret += getText(elem);
          }
        }
      } else if (nodeType === 3 || nodeType === 4) {
        return elem.nodeValue;
      }
      return ret;
    };
    Expr = Sizzle.selectors = {
      cacheLength: 50,
      createPseudo: markFunction,
      match: matchExpr,
      attrHandle: {},
      find: {},
      relative: {
        ">": {
          dir: "parentNode",
          first: true
        },
        " ": {dir: "parentNode"},
        "+": {
          dir: "previousSibling",
          first: true
        },
        "~": {dir: "previousSibling"}
      },
      preFilter: {
        "ATTR": function(match) {
          match[1] = match[1].replace(runescape, funescape);
          match[3] = (match[3] || match[4] || match[5] || "").replace(runescape, funescape);
          if (match[2] === "~=") {
            match[3] = " " + match[3] + " ";
          }
          return match.slice(0, 4);
        },
        "CHILD": function(match) {
          match[1] = match[1].toLowerCase();
          if (match[1].slice(0, 3) === "nth") {
            if (!match[3]) {
              Sizzle.error(match[0]);
            }
            match[4] = +(match[4] ? match[5] + (match[6] || 1) : 2 * (match[3] === "even" || match[3] === "odd"));
            match[5] = +((match[7] + match[8]) || match[3] === "odd");
          } else if (match[3]) {
            Sizzle.error(match[0]);
          }
          return match;
        },
        "PSEUDO": function(match) {
          var excess,
              unquoted = !match[6] && match[2];
          if (matchExpr["CHILD"].test(match[0])) {
            return null;
          }
          if (match[3]) {
            match[2] = match[4] || match[5] || "";
          } else if (unquoted && rpseudo.test(unquoted) && (excess = tokenize(unquoted, true)) && (excess = unquoted.indexOf(")", unquoted.length - excess) - unquoted.length)) {
            match[0] = match[0].slice(0, excess);
            match[2] = unquoted.slice(0, excess);
          }
          return match.slice(0, 3);
        }
      },
      filter: {
        "TAG": function(nodeNameSelector) {
          var nodeName = nodeNameSelector.replace(runescape, funescape).toLowerCase();
          return nodeNameSelector === "*" ? function() {
            return true;
          } : function(elem) {
            return elem.nodeName && elem.nodeName.toLowerCase() === nodeName;
          };
        },
        "CLASS": function(className) {
          var pattern = classCache[className + " "];
          return pattern || (pattern = new RegExp("(^|" + whitespace + ")" + className + "(" + whitespace + "|$)")) && classCache(className, function(elem) {
            return pattern.test(typeof elem.className === "string" && elem.className || typeof elem.getAttribute !== "undefined" && elem.getAttribute("class") || "");
          });
        },
        "ATTR": function(name, operator, check) {
          return function(elem) {
            var result = Sizzle.attr(elem, name);
            if (result == null) {
              return operator === "!=";
            }
            if (!operator) {
              return true;
            }
            result += "";
            return operator === "=" ? result === check : operator === "!=" ? result !== check : operator === "^=" ? check && result.indexOf(check) === 0 : operator === "*=" ? check && result.indexOf(check) > -1 : operator === "$=" ? check && result.slice(-check.length) === check : operator === "~=" ? (" " + result.replace(rwhitespace, " ") + " ").indexOf(check) > -1 : operator === "|=" ? result === check || result.slice(0, check.length + 1) === check + "-" : false;
          };
        },
        "CHILD": function(type, what, argument, first, last) {
          var simple = type.slice(0, 3) !== "nth",
              forward = type.slice(-4) !== "last",
              ofType = what === "of-type";
          return first === 1 && last === 0 ? function(elem) {
            return !!elem.parentNode;
          } : function(elem, context, xml) {
            var cache,
                outerCache,
                node,
                diff,
                nodeIndex,
                start,
                dir = simple !== forward ? "nextSibling" : "previousSibling",
                parent = elem.parentNode,
                name = ofType && elem.nodeName.toLowerCase(),
                useCache = !xml && !ofType;
            if (parent) {
              if (simple) {
                while (dir) {
                  node = elem;
                  while ((node = node[dir])) {
                    if (ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1) {
                      return false;
                    }
                  }
                  start = dir = type === "only" && !start && "nextSibling";
                }
                return true;
              }
              start = [forward ? parent.firstChild : parent.lastChild];
              if (forward && useCache) {
                outerCache = parent[expando] || (parent[expando] = {});
                cache = outerCache[type] || [];
                nodeIndex = cache[0] === dirruns && cache[1];
                diff = cache[0] === dirruns && cache[2];
                node = nodeIndex && parent.childNodes[nodeIndex];
                while ((node = ++nodeIndex && node && node[dir] || (diff = nodeIndex = 0) || start.pop())) {
                  if (node.nodeType === 1 && ++diff && node === elem) {
                    outerCache[type] = [dirruns, nodeIndex, diff];
                    break;
                  }
                }
              } else if (useCache && (cache = (elem[expando] || (elem[expando] = {}))[type]) && cache[0] === dirruns) {
                diff = cache[1];
              } else {
                while ((node = ++nodeIndex && node && node[dir] || (diff = nodeIndex = 0) || start.pop())) {
                  if ((ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1) && ++diff) {
                    if (useCache) {
                      (node[expando] || (node[expando] = {}))[type] = [dirruns, diff];
                    }
                    if (node === elem) {
                      break;
                    }
                  }
                }
              }
              diff -= last;
              return diff === first || (diff % first === 0 && diff / first >= 0);
            }
          };
        },
        "PSEUDO": function(pseudo, argument) {
          var args,
              fn = Expr.pseudos[pseudo] || Expr.setFilters[pseudo.toLowerCase()] || Sizzle.error("unsupported pseudo: " + pseudo);
          if (fn[expando]) {
            return fn(argument);
          }
          if (fn.length > 1) {
            args = [pseudo, pseudo, "", argument];
            return Expr.setFilters.hasOwnProperty(pseudo.toLowerCase()) ? markFunction(function(seed, matches) {
              var idx,
                  matched = fn(seed, argument),
                  i = matched.length;
              while (i--) {
                idx = indexOf(seed, matched[i]);
                seed[idx] = !(matches[idx] = matched[i]);
              }
            }) : function(elem) {
              return fn(elem, 0, args);
            };
          }
          return fn;
        }
      },
      pseudos: {
        "not": markFunction(function(selector) {
          var input = [],
              results = [],
              matcher = compile(selector.replace(rtrim, "$1"));
          return matcher[expando] ? markFunction(function(seed, matches, context, xml) {
            var elem,
                unmatched = matcher(seed, null, xml, []),
                i = seed.length;
            while (i--) {
              if ((elem = unmatched[i])) {
                seed[i] = !(matches[i] = elem);
              }
            }
          }) : function(elem, context, xml) {
            input[0] = elem;
            matcher(input, null, xml, results);
            input[0] = null;
            return !results.pop();
          };
        }),
        "has": markFunction(function(selector) {
          return function(elem) {
            return Sizzle(selector, elem).length > 0;
          };
        }),
        "contains": markFunction(function(text) {
          text = text.replace(runescape, funescape);
          return function(elem) {
            return (elem.textContent || elem.innerText || getText(elem)).indexOf(text) > -1;
          };
        }),
        "lang": markFunction(function(lang) {
          if (!ridentifier.test(lang || "")) {
            Sizzle.error("unsupported lang: " + lang);
          }
          lang = lang.replace(runescape, funescape).toLowerCase();
          return function(elem) {
            var elemLang;
            do {
              if ((elemLang = documentIsHTML ? elem.lang : elem.getAttribute("xml:lang") || elem.getAttribute("lang"))) {
                elemLang = elemLang.toLowerCase();
                return elemLang === lang || elemLang.indexOf(lang + "-") === 0;
              }
            } while ((elem = elem.parentNode) && elem.nodeType === 1);
            return false;
          };
        }),
        "target": function(elem) {
          var hash = window.location && window.location.hash;
          return hash && hash.slice(1) === elem.id;
        },
        "root": function(elem) {
          return elem === docElem;
        },
        "focus": function(elem) {
          return elem === document.activeElement && (!document.hasFocus || document.hasFocus()) && !!(elem.type || elem.href || ~elem.tabIndex);
        },
        "enabled": function(elem) {
          return elem.disabled === false;
        },
        "disabled": function(elem) {
          return elem.disabled === true;
        },
        "checked": function(elem) {
          var nodeName = elem.nodeName.toLowerCase();
          return (nodeName === "input" && !!elem.checked) || (nodeName === "option" && !!elem.selected);
        },
        "selected": function(elem) {
          if (elem.parentNode) {
            elem.parentNode.selectedIndex;
          }
          return elem.selected === true;
        },
        "empty": function(elem) {
          for (elem = elem.firstChild; elem; elem = elem.nextSibling) {
            if (elem.nodeType < 6) {
              return false;
            }
          }
          return true;
        },
        "parent": function(elem) {
          return !Expr.pseudos["empty"](elem);
        },
        "header": function(elem) {
          return rheader.test(elem.nodeName);
        },
        "input": function(elem) {
          return rinputs.test(elem.nodeName);
        },
        "button": function(elem) {
          var name = elem.nodeName.toLowerCase();
          return name === "input" && elem.type === "button" || name === "button";
        },
        "text": function(elem) {
          var attr;
          return elem.nodeName.toLowerCase() === "input" && elem.type === "text" && ((attr = elem.getAttribute("type")) == null || attr.toLowerCase() === "text");
        },
        "first": createPositionalPseudo(function() {
          return [0];
        }),
        "last": createPositionalPseudo(function(matchIndexes, length) {
          return [length - 1];
        }),
        "eq": createPositionalPseudo(function(matchIndexes, length, argument) {
          return [argument < 0 ? argument + length : argument];
        }),
        "even": createPositionalPseudo(function(matchIndexes, length) {
          var i = 0;
          for (; i < length; i += 2) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "odd": createPositionalPseudo(function(matchIndexes, length) {
          var i = 1;
          for (; i < length; i += 2) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "lt": createPositionalPseudo(function(matchIndexes, length, argument) {
          var i = argument < 0 ? argument + length : argument;
          for (; --i >= 0; ) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "gt": createPositionalPseudo(function(matchIndexes, length, argument) {
          var i = argument < 0 ? argument + length : argument;
          for (; ++i < length; ) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        })
      }
    };
    Expr.pseudos["nth"] = Expr.pseudos["eq"];
    for (i in {
      radio: true,
      checkbox: true,
      file: true,
      password: true,
      image: true
    }) {
      Expr.pseudos[i] = createInputPseudo(i);
    }
    for (i in {
      submit: true,
      reset: true
    }) {
      Expr.pseudos[i] = createButtonPseudo(i);
    }
    function setFilters() {}
    setFilters.prototype = Expr.filters = Expr.pseudos;
    Expr.setFilters = new setFilters();
    tokenize = Sizzle.tokenize = function(selector, parseOnly) {
      var matched,
          match,
          tokens,
          type,
          soFar,
          groups,
          preFilters,
          cached = tokenCache[selector + " "];
      if (cached) {
        return parseOnly ? 0 : cached.slice(0);
      }
      soFar = selector;
      groups = [];
      preFilters = Expr.preFilter;
      while (soFar) {
        if (!matched || (match = rcomma.exec(soFar))) {
          if (match) {
            soFar = soFar.slice(match[0].length) || soFar;
          }
          groups.push((tokens = []));
        }
        matched = false;
        if ((match = rcombinators.exec(soFar))) {
          matched = match.shift();
          tokens.push({
            value: matched,
            type: match[0].replace(rtrim, " ")
          });
          soFar = soFar.slice(matched.length);
        }
        for (type in Expr.filter) {
          if ((match = matchExpr[type].exec(soFar)) && (!preFilters[type] || (match = preFilters[type](match)))) {
            matched = match.shift();
            tokens.push({
              value: matched,
              type: type,
              matches: match
            });
            soFar = soFar.slice(matched.length);
          }
        }
        if (!matched) {
          break;
        }
      }
      return parseOnly ? soFar.length : soFar ? Sizzle.error(selector) : tokenCache(selector, groups).slice(0);
    };
    function toSelector(tokens) {
      var i = 0,
          len = tokens.length,
          selector = "";
      for (; i < len; i++) {
        selector += tokens[i].value;
      }
      return selector;
    }
    function addCombinator(matcher, combinator, base) {
      var dir = combinator.dir,
          checkNonElements = base && dir === "parentNode",
          doneName = done++;
      return combinator.first ? function(elem, context, xml) {
        while ((elem = elem[dir])) {
          if (elem.nodeType === 1 || checkNonElements) {
            return matcher(elem, context, xml);
          }
        }
      } : function(elem, context, xml) {
        var oldCache,
            outerCache,
            newCache = [dirruns, doneName];
        if (xml) {
          while ((elem = elem[dir])) {
            if (elem.nodeType === 1 || checkNonElements) {
              if (matcher(elem, context, xml)) {
                return true;
              }
            }
          }
        } else {
          while ((elem = elem[dir])) {
            if (elem.nodeType === 1 || checkNonElements) {
              outerCache = elem[expando] || (elem[expando] = {});
              if ((oldCache = outerCache[dir]) && oldCache[0] === dirruns && oldCache[1] === doneName) {
                return (newCache[2] = oldCache[2]);
              } else {
                outerCache[dir] = newCache;
                if ((newCache[2] = matcher(elem, context, xml))) {
                  return true;
                }
              }
            }
          }
        }
      };
    }
    function elementMatcher(matchers) {
      return matchers.length > 1 ? function(elem, context, xml) {
        var i = matchers.length;
        while (i--) {
          if (!matchers[i](elem, context, xml)) {
            return false;
          }
        }
        return true;
      } : matchers[0];
    }
    function multipleContexts(selector, contexts, results) {
      var i = 0,
          len = contexts.length;
      for (; i < len; i++) {
        Sizzle(selector, contexts[i], results);
      }
      return results;
    }
    function condense(unmatched, map, filter, context, xml) {
      var elem,
          newUnmatched = [],
          i = 0,
          len = unmatched.length,
          mapped = map != null;
      for (; i < len; i++) {
        if ((elem = unmatched[i])) {
          if (!filter || filter(elem, context, xml)) {
            newUnmatched.push(elem);
            if (mapped) {
              map.push(i);
            }
          }
        }
      }
      return newUnmatched;
    }
    function setMatcher(preFilter, selector, matcher, postFilter, postFinder, postSelector) {
      if (postFilter && !postFilter[expando]) {
        postFilter = setMatcher(postFilter);
      }
      if (postFinder && !postFinder[expando]) {
        postFinder = setMatcher(postFinder, postSelector);
      }
      return markFunction(function(seed, results, context, xml) {
        var temp,
            i,
            elem,
            preMap = [],
            postMap = [],
            preexisting = results.length,
            elems = seed || multipleContexts(selector || "*", context.nodeType ? [context] : context, []),
            matcherIn = preFilter && (seed || !selector) ? condense(elems, preMap, preFilter, context, xml) : elems,
            matcherOut = matcher ? postFinder || (seed ? preFilter : preexisting || postFilter) ? [] : results : matcherIn;
        if (matcher) {
          matcher(matcherIn, matcherOut, context, xml);
        }
        if (postFilter) {
          temp = condense(matcherOut, postMap);
          postFilter(temp, [], context, xml);
          i = temp.length;
          while (i--) {
            if ((elem = temp[i])) {
              matcherOut[postMap[i]] = !(matcherIn[postMap[i]] = elem);
            }
          }
        }
        if (seed) {
          if (postFinder || preFilter) {
            if (postFinder) {
              temp = [];
              i = matcherOut.length;
              while (i--) {
                if ((elem = matcherOut[i])) {
                  temp.push((matcherIn[i] = elem));
                }
              }
              postFinder(null, (matcherOut = []), temp, xml);
            }
            i = matcherOut.length;
            while (i--) {
              if ((elem = matcherOut[i]) && (temp = postFinder ? indexOf(seed, elem) : preMap[i]) > -1) {
                seed[temp] = !(results[temp] = elem);
              }
            }
          }
        } else {
          matcherOut = condense(matcherOut === results ? matcherOut.splice(preexisting, matcherOut.length) : matcherOut);
          if (postFinder) {
            postFinder(null, results, matcherOut, xml);
          } else {
            push.apply(results, matcherOut);
          }
        }
      });
    }
    function matcherFromTokens(tokens) {
      var checkContext,
          matcher,
          j,
          len = tokens.length,
          leadingRelative = Expr.relative[tokens[0].type],
          implicitRelative = leadingRelative || Expr.relative[" "],
          i = leadingRelative ? 1 : 0,
          matchContext = addCombinator(function(elem) {
            return elem === checkContext;
          }, implicitRelative, true),
          matchAnyContext = addCombinator(function(elem) {
            return indexOf(checkContext, elem) > -1;
          }, implicitRelative, true),
          matchers = [function(elem, context, xml) {
            var ret = (!leadingRelative && (xml || context !== outermostContext)) || ((checkContext = context).nodeType ? matchContext(elem, context, xml) : matchAnyContext(elem, context, xml));
            checkContext = null;
            return ret;
          }];
      for (; i < len; i++) {
        if ((matcher = Expr.relative[tokens[i].type])) {
          matchers = [addCombinator(elementMatcher(matchers), matcher)];
        } else {
          matcher = Expr.filter[tokens[i].type].apply(null, tokens[i].matches);
          if (matcher[expando]) {
            j = ++i;
            for (; j < len; j++) {
              if (Expr.relative[tokens[j].type]) {
                break;
              }
            }
            return setMatcher(i > 1 && elementMatcher(matchers), i > 1 && toSelector(tokens.slice(0, i - 1).concat({value: tokens[i - 2].type === " " ? "*" : ""})).replace(rtrim, "$1"), matcher, i < j && matcherFromTokens(tokens.slice(i, j)), j < len && matcherFromTokens((tokens = tokens.slice(j))), j < len && toSelector(tokens));
          }
          matchers.push(matcher);
        }
      }
      return elementMatcher(matchers);
    }
    function matcherFromGroupMatchers(elementMatchers, setMatchers) {
      var bySet = setMatchers.length > 0,
          byElement = elementMatchers.length > 0,
          superMatcher = function(seed, context, xml, results, outermost) {
            var elem,
                j,
                matcher,
                matchedCount = 0,
                i = "0",
                unmatched = seed && [],
                setMatched = [],
                contextBackup = outermostContext,
                elems = seed || byElement && Expr.find["TAG"]("*", outermost),
                dirrunsUnique = (dirruns += contextBackup == null ? 1 : Math.random() || 0.1),
                len = elems.length;
            if (outermost) {
              outermostContext = context !== document && context;
            }
            for (; i !== len && (elem = elems[i]) != null; i++) {
              if (byElement && elem) {
                j = 0;
                while ((matcher = elementMatchers[j++])) {
                  if (matcher(elem, context, xml)) {
                    results.push(elem);
                    break;
                  }
                }
                if (outermost) {
                  dirruns = dirrunsUnique;
                }
              }
              if (bySet) {
                if ((elem = !matcher && elem)) {
                  matchedCount--;
                }
                if (seed) {
                  unmatched.push(elem);
                }
              }
            }
            matchedCount += i;
            if (bySet && i !== matchedCount) {
              j = 0;
              while ((matcher = setMatchers[j++])) {
                matcher(unmatched, setMatched, context, xml);
              }
              if (seed) {
                if (matchedCount > 0) {
                  while (i--) {
                    if (!(unmatched[i] || setMatched[i])) {
                      setMatched[i] = pop.call(results);
                    }
                  }
                }
                setMatched = condense(setMatched);
              }
              push.apply(results, setMatched);
              if (outermost && !seed && setMatched.length > 0 && (matchedCount + setMatchers.length) > 1) {
                Sizzle.uniqueSort(results);
              }
            }
            if (outermost) {
              dirruns = dirrunsUnique;
              outermostContext = contextBackup;
            }
            return unmatched;
          };
      return bySet ? markFunction(superMatcher) : superMatcher;
    }
    compile = Sizzle.compile = function(selector, match) {
      var i,
          setMatchers = [],
          elementMatchers = [],
          cached = compilerCache[selector + " "];
      if (!cached) {
        if (!match) {
          match = tokenize(selector);
        }
        i = match.length;
        while (i--) {
          cached = matcherFromTokens(match[i]);
          if (cached[expando]) {
            setMatchers.push(cached);
          } else {
            elementMatchers.push(cached);
          }
        }
        cached = compilerCache(selector, matcherFromGroupMatchers(elementMatchers, setMatchers));
        cached.selector = selector;
      }
      return cached;
    };
    select = Sizzle.select = function(selector, context, results, seed) {
      var i,
          tokens,
          token,
          type,
          find,
          compiled = typeof selector === "function" && selector,
          match = !seed && tokenize((selector = compiled.selector || selector));
      results = results || [];
      if (match.length === 1) {
        tokens = match[0] = match[0].slice(0);
        if (tokens.length > 2 && (token = tokens[0]).type === "ID" && support.getById && context.nodeType === 9 && documentIsHTML && Expr.relative[tokens[1].type]) {
          context = (Expr.find["ID"](token.matches[0].replace(runescape, funescape), context) || [])[0];
          if (!context) {
            return results;
          } else if (compiled) {
            context = context.parentNode;
          }
          selector = selector.slice(tokens.shift().value.length);
        }
        i = matchExpr["needsContext"].test(selector) ? 0 : tokens.length;
        while (i--) {
          token = tokens[i];
          if (Expr.relative[(type = token.type)]) {
            break;
          }
          if ((find = Expr.find[type])) {
            if ((seed = find(token.matches[0].replace(runescape, funescape), rsibling.test(tokens[0].type) && testContext(context.parentNode) || context))) {
              tokens.splice(i, 1);
              selector = seed.length && toSelector(tokens);
              if (!selector) {
                push.apply(results, seed);
                return results;
              }
              break;
            }
          }
        }
      }
      (compiled || compile(selector, match))(seed, context, !documentIsHTML, results, rsibling.test(selector) && testContext(context.parentNode) || context);
      return results;
    };
    support.sortStable = expando.split("").sort(sortOrder).join("") === expando;
    support.detectDuplicates = !!hasDuplicate;
    setDocument();
    support.sortDetached = assert(function(div1) {
      return div1.compareDocumentPosition(document.createElement("div")) & 1;
    });
    if (!assert(function(div) {
      div.innerHTML = "<a href='#'></a>";
      return div.firstChild.getAttribute("href") === "#";
    })) {
      addHandle("type|href|height|width", function(elem, name, isXML) {
        if (!isXML) {
          return elem.getAttribute(name, name.toLowerCase() === "type" ? 1 : 2);
        }
      });
    }
    if (!support.attributes || !assert(function(div) {
      div.innerHTML = "<input/>";
      div.firstChild.setAttribute("value", "");
      return div.firstChild.getAttribute("value") === "";
    })) {
      addHandle("value", function(elem, name, isXML) {
        if (!isXML && elem.nodeName.toLowerCase() === "input") {
          return elem.defaultValue;
        }
      });
    }
    if (!assert(function(div) {
      return div.getAttribute("disabled") == null;
    })) {
      addHandle(booleans, function(elem, name, isXML) {
        var val;
        if (!isXML) {
          return elem[name] === true ? name.toLowerCase() : (val = elem.getAttributeNode(name)) && val.specified ? val.value : null;
        }
      });
    }
    return Sizzle;
  })(window);
  jQuery.find = Sizzle;
  jQuery.expr = Sizzle.selectors;
  jQuery.expr[":"] = jQuery.expr.pseudos;
  jQuery.unique = Sizzle.uniqueSort;
  jQuery.text = Sizzle.getText;
  jQuery.isXMLDoc = Sizzle.isXML;
  jQuery.contains = Sizzle.contains;
  var rneedsContext = jQuery.expr.match.needsContext;
  var rsingleTag = (/^<(\w+)\s*\/?>(?:<\/\1>|)$/);
  var risSimple = /^.[^:#\[\.,]*$/;
  function winnow(elements, qualifier, not) {
    if (jQuery.isFunction(qualifier)) {
      return jQuery.grep(elements, function(elem, i) {
        return !!qualifier.call(elem, i, elem) !== not;
      });
    }
    if (qualifier.nodeType) {
      return jQuery.grep(elements, function(elem) {
        return (elem === qualifier) !== not;
      });
    }
    if (typeof qualifier === "string") {
      if (risSimple.test(qualifier)) {
        return jQuery.filter(qualifier, elements, not);
      }
      qualifier = jQuery.filter(qualifier, elements);
    }
    return jQuery.grep(elements, function(elem) {
      return (indexOf.call(qualifier, elem) >= 0) !== not;
    });
  }
  jQuery.filter = function(expr, elems, not) {
    var elem = elems[0];
    if (not) {
      expr = ":not(" + expr + ")";
    }
    return elems.length === 1 && elem.nodeType === 1 ? jQuery.find.matchesSelector(elem, expr) ? [elem] : [] : jQuery.find.matches(expr, jQuery.grep(elems, function(elem) {
      return elem.nodeType === 1;
    }));
  };
  jQuery.fn.extend({
    find: function(selector) {
      var i,
          len = this.length,
          ret = [],
          self = this;
      if (typeof selector !== "string") {
        return this.pushStack(jQuery(selector).filter(function() {
          for (i = 0; i < len; i++) {
            if (jQuery.contains(self[i], this)) {
              return true;
            }
          }
        }));
      }
      for (i = 0; i < len; i++) {
        jQuery.find(selector, self[i], ret);
      }
      ret = this.pushStack(len > 1 ? jQuery.unique(ret) : ret);
      ret.selector = this.selector ? this.selector + " " + selector : selector;
      return ret;
    },
    filter: function(selector) {
      return this.pushStack(winnow(this, selector || [], false));
    },
    not: function(selector) {
      return this.pushStack(winnow(this, selector || [], true));
    },
    is: function(selector) {
      return !!winnow(this, typeof selector === "string" && rneedsContext.test(selector) ? jQuery(selector) : selector || [], false).length;
    }
  });
  var rootjQuery,
      rquickExpr = /^(?:\s*(<[\w\W]+>)[^>]*|#([\w-]*))$/,
      init = jQuery.fn.init = function(selector, context) {
        var match,
            elem;
        if (!selector) {
          return this;
        }
        if (typeof selector === "string") {
          if (selector[0] === "<" && selector[selector.length - 1] === ">" && selector.length >= 3) {
            match = [null, selector, null];
          } else {
            match = rquickExpr.exec(selector);
          }
          if (match && (match[1] || !context)) {
            if (match[1]) {
              context = context instanceof jQuery ? context[0] : context;
              jQuery.merge(this, jQuery.parseHTML(match[1], context && context.nodeType ? context.ownerDocument || context : document, true));
              if (rsingleTag.test(match[1]) && jQuery.isPlainObject(context)) {
                for (match in context) {
                  if (jQuery.isFunction(this[match])) {
                    this[match](context[match]);
                  } else {
                    this.attr(match, context[match]);
                  }
                }
              }
              return this;
            } else {
              elem = document.getElementById(match[2]);
              if (elem && elem.parentNode) {
                this.length = 1;
                this[0] = elem;
              }
              this.context = document;
              this.selector = selector;
              return this;
            }
          } else if (!context || context.jquery) {
            return (context || rootjQuery).find(selector);
          } else {
            return this.constructor(context).find(selector);
          }
        } else if (selector.nodeType) {
          this.context = this[0] = selector;
          this.length = 1;
          return this;
        } else if (jQuery.isFunction(selector)) {
          return typeof rootjQuery.ready !== "undefined" ? rootjQuery.ready(selector) : selector(jQuery);
        }
        if (selector.selector !== undefined) {
          this.selector = selector.selector;
          this.context = selector.context;
        }
        return jQuery.makeArray(selector, this);
      };
  init.prototype = jQuery.fn;
  rootjQuery = jQuery(document);
  var rparentsprev = /^(?:parents|prev(?:Until|All))/,
      guaranteedUnique = {
        children: true,
        contents: true,
        next: true,
        prev: true
      };
  jQuery.extend({
    dir: function(elem, dir, until) {
      var matched = [],
          truncate = until !== undefined;
      while ((elem = elem[dir]) && elem.nodeType !== 9) {
        if (elem.nodeType === 1) {
          if (truncate && jQuery(elem).is(until)) {
            break;
          }
          matched.push(elem);
        }
      }
      return matched;
    },
    sibling: function(n, elem) {
      var matched = [];
      for (; n; n = n.nextSibling) {
        if (n.nodeType === 1 && n !== elem) {
          matched.push(n);
        }
      }
      return matched;
    }
  });
  jQuery.fn.extend({
    has: function(target) {
      var targets = jQuery(target, this),
          l = targets.length;
      return this.filter(function() {
        var i = 0;
        for (; i < l; i++) {
          if (jQuery.contains(this, targets[i])) {
            return true;
          }
        }
      });
    },
    closest: function(selectors, context) {
      var cur,
          i = 0,
          l = this.length,
          matched = [],
          pos = rneedsContext.test(selectors) || typeof selectors !== "string" ? jQuery(selectors, context || this.context) : 0;
      for (; i < l; i++) {
        for (cur = this[i]; cur && cur !== context; cur = cur.parentNode) {
          if (cur.nodeType < 11 && (pos ? pos.index(cur) > -1 : cur.nodeType === 1 && jQuery.find.matchesSelector(cur, selectors))) {
            matched.push(cur);
            break;
          }
        }
      }
      return this.pushStack(matched.length > 1 ? jQuery.unique(matched) : matched);
    },
    index: function(elem) {
      if (!elem) {
        return (this[0] && this[0].parentNode) ? this.first().prevAll().length : -1;
      }
      if (typeof elem === "string") {
        return indexOf.call(jQuery(elem), this[0]);
      }
      return indexOf.call(this, elem.jquery ? elem[0] : elem);
    },
    add: function(selector, context) {
      return this.pushStack(jQuery.unique(jQuery.merge(this.get(), jQuery(selector, context))));
    },
    addBack: function(selector) {
      return this.add(selector == null ? this.prevObject : this.prevObject.filter(selector));
    }
  });
  function sibling(cur, dir) {
    while ((cur = cur[dir]) && cur.nodeType !== 1) {}
    return cur;
  }
  jQuery.each({
    parent: function(elem) {
      var parent = elem.parentNode;
      return parent && parent.nodeType !== 11 ? parent : null;
    },
    parents: function(elem) {
      return jQuery.dir(elem, "parentNode");
    },
    parentsUntil: function(elem, i, until) {
      return jQuery.dir(elem, "parentNode", until);
    },
    next: function(elem) {
      return sibling(elem, "nextSibling");
    },
    prev: function(elem) {
      return sibling(elem, "previousSibling");
    },
    nextAll: function(elem) {
      return jQuery.dir(elem, "nextSibling");
    },
    prevAll: function(elem) {
      return jQuery.dir(elem, "previousSibling");
    },
    nextUntil: function(elem, i, until) {
      return jQuery.dir(elem, "nextSibling", until);
    },
    prevUntil: function(elem, i, until) {
      return jQuery.dir(elem, "previousSibling", until);
    },
    siblings: function(elem) {
      return jQuery.sibling((elem.parentNode || {}).firstChild, elem);
    },
    children: function(elem) {
      return jQuery.sibling(elem.firstChild);
    },
    contents: function(elem) {
      return elem.contentDocument || jQuery.merge([], elem.childNodes);
    }
  }, function(name, fn) {
    jQuery.fn[name] = function(until, selector) {
      var matched = jQuery.map(this, fn, until);
      if (name.slice(-5) !== "Until") {
        selector = until;
      }
      if (selector && typeof selector === "string") {
        matched = jQuery.filter(selector, matched);
      }
      if (this.length > 1) {
        if (!guaranteedUnique[name]) {
          jQuery.unique(matched);
        }
        if (rparentsprev.test(name)) {
          matched.reverse();
        }
      }
      return this.pushStack(matched);
    };
  });
  var rnotwhite = (/\S+/g);
  var optionsCache = {};
  function createOptions(options) {
    var object = optionsCache[options] = {};
    jQuery.each(options.match(rnotwhite) || [], function(_, flag) {
      object[flag] = true;
    });
    return object;
  }
  jQuery.Callbacks = function(options) {
    options = typeof options === "string" ? (optionsCache[options] || createOptions(options)) : jQuery.extend({}, options);
    var memory,
        fired,
        firing,
        firingStart,
        firingLength,
        firingIndex,
        list = [],
        stack = !options.once && [],
        fire = function(data) {
          memory = options.memory && data;
          fired = true;
          firingIndex = firingStart || 0;
          firingStart = 0;
          firingLength = list.length;
          firing = true;
          for (; list && firingIndex < firingLength; firingIndex++) {
            if (list[firingIndex].apply(data[0], data[1]) === false && options.stopOnFalse) {
              memory = false;
              break;
            }
          }
          firing = false;
          if (list) {
            if (stack) {
              if (stack.length) {
                fire(stack.shift());
              }
            } else if (memory) {
              list = [];
            } else {
              self.disable();
            }
          }
        },
        self = {
          add: function() {
            if (list) {
              var start = list.length;
              (function add(args) {
                jQuery.each(args, function(_, arg) {
                  var type = jQuery.type(arg);
                  if (type === "function") {
                    if (!options.unique || !self.has(arg)) {
                      list.push(arg);
                    }
                  } else if (arg && arg.length && type !== "string") {
                    add(arg);
                  }
                });
              })(arguments);
              if (firing) {
                firingLength = list.length;
              } else if (memory) {
                firingStart = start;
                fire(memory);
              }
            }
            return this;
          },
          remove: function() {
            if (list) {
              jQuery.each(arguments, function(_, arg) {
                var index;
                while ((index = jQuery.inArray(arg, list, index)) > -1) {
                  list.splice(index, 1);
                  if (firing) {
                    if (index <= firingLength) {
                      firingLength--;
                    }
                    if (index <= firingIndex) {
                      firingIndex--;
                    }
                  }
                }
              });
            }
            return this;
          },
          has: function(fn) {
            return fn ? jQuery.inArray(fn, list) > -1 : !!(list && list.length);
          },
          empty: function() {
            list = [];
            firingLength = 0;
            return this;
          },
          disable: function() {
            list = stack = memory = undefined;
            return this;
          },
          disabled: function() {
            return !list;
          },
          lock: function() {
            stack = undefined;
            if (!memory) {
              self.disable();
            }
            return this;
          },
          locked: function() {
            return !stack;
          },
          fireWith: function(context, args) {
            if (list && (!fired || stack)) {
              args = args || [];
              args = [context, args.slice ? args.slice() : args];
              if (firing) {
                stack.push(args);
              } else {
                fire(args);
              }
            }
            return this;
          },
          fire: function() {
            self.fireWith(this, arguments);
            return this;
          },
          fired: function() {
            return !!fired;
          }
        };
    return self;
  };
  jQuery.extend({
    Deferred: function(func) {
      var tuples = [["resolve", "done", jQuery.Callbacks("once memory"), "resolved"], ["reject", "fail", jQuery.Callbacks("once memory"), "rejected"], ["notify", "progress", jQuery.Callbacks("memory")]],
          state = "pending",
          promise = {
            state: function() {
              return state;
            },
            always: function() {
              deferred.done(arguments).fail(arguments);
              return this;
            },
            then: function() {
              var fns = arguments;
              return jQuery.Deferred(function(newDefer) {
                jQuery.each(tuples, function(i, tuple) {
                  var fn = jQuery.isFunction(fns[i]) && fns[i];
                  deferred[tuple[1]](function() {
                    var returned = fn && fn.apply(this, arguments);
                    if (returned && jQuery.isFunction(returned.promise)) {
                      returned.promise().done(newDefer.resolve).fail(newDefer.reject).progress(newDefer.notify);
                    } else {
                      newDefer[tuple[0] + "With"](this === promise ? newDefer.promise() : this, fn ? [returned] : arguments);
                    }
                  });
                });
                fns = null;
              }).promise();
            },
            promise: function(obj) {
              return obj != null ? jQuery.extend(obj, promise) : promise;
            }
          },
          deferred = {};
      promise.pipe = promise.then;
      jQuery.each(tuples, function(i, tuple) {
        var list = tuple[2],
            stateString = tuple[3];
        promise[tuple[1]] = list.add;
        if (stateString) {
          list.add(function() {
            state = stateString;
          }, tuples[i ^ 1][2].disable, tuples[2][2].lock);
        }
        deferred[tuple[0]] = function() {
          deferred[tuple[0] + "With"](this === deferred ? promise : this, arguments);
          return this;
        };
        deferred[tuple[0] + "With"] = list.fireWith;
      });
      promise.promise(deferred);
      if (func) {
        func.call(deferred, deferred);
      }
      return deferred;
    },
    when: function(subordinate) {
      var i = 0,
          resolveValues = slice.call(arguments),
          length = resolveValues.length,
          remaining = length !== 1 || (subordinate && jQuery.isFunction(subordinate.promise)) ? length : 0,
          deferred = remaining === 1 ? subordinate : jQuery.Deferred(),
          updateFunc = function(i, contexts, values) {
            return function(value) {
              contexts[i] = this;
              values[i] = arguments.length > 1 ? slice.call(arguments) : value;
              if (values === progressValues) {
                deferred.notifyWith(contexts, values);
              } else if (!(--remaining)) {
                deferred.resolveWith(contexts, values);
              }
            };
          },
          progressValues,
          progressContexts,
          resolveContexts;
      if (length > 1) {
        progressValues = new Array(length);
        progressContexts = new Array(length);
        resolveContexts = new Array(length);
        for (; i < length; i++) {
          if (resolveValues[i] && jQuery.isFunction(resolveValues[i].promise)) {
            resolveValues[i].promise().done(updateFunc(i, resolveContexts, resolveValues)).fail(deferred.reject).progress(updateFunc(i, progressContexts, progressValues));
          } else {
            --remaining;
          }
        }
      }
      if (!remaining) {
        deferred.resolveWith(resolveContexts, resolveValues);
      }
      return deferred.promise();
    }
  });
  var readyList;
  jQuery.fn.ready = function(fn) {
    jQuery.ready.promise().done(fn);
    return this;
  };
  jQuery.extend({
    isReady: false,
    readyWait: 1,
    holdReady: function(hold) {
      if (hold) {
        jQuery.readyWait++;
      } else {
        jQuery.ready(true);
      }
    },
    ready: function(wait) {
      if (wait === true ? --jQuery.readyWait : jQuery.isReady) {
        return ;
      }
      jQuery.isReady = true;
      if (wait !== true && --jQuery.readyWait > 0) {
        return ;
      }
      readyList.resolveWith(document, [jQuery]);
      if (jQuery.fn.triggerHandler) {
        jQuery(document).triggerHandler("ready");
        jQuery(document).off("ready");
      }
    }
  });
  function completed() {
    document.removeEventListener("DOMContentLoaded", completed, false);
    window.removeEventListener("load", completed, false);
    jQuery.ready();
  }
  jQuery.ready.promise = function(obj) {
    if (!readyList) {
      readyList = jQuery.Deferred();
      if (document.readyState === "complete") {
        setTimeout(jQuery.ready);
      } else {
        document.addEventListener("DOMContentLoaded", completed, false);
        window.addEventListener("load", completed, false);
      }
    }
    return readyList.promise(obj);
  };
  jQuery.ready.promise();
  var access = jQuery.access = function(elems, fn, key, value, chainable, emptyGet, raw) {
    var i = 0,
        len = elems.length,
        bulk = key == null;
    if (jQuery.type(key) === "object") {
      chainable = true;
      for (i in key) {
        jQuery.access(elems, fn, i, key[i], true, emptyGet, raw);
      }
    } else if (value !== undefined) {
      chainable = true;
      if (!jQuery.isFunction(value)) {
        raw = true;
      }
      if (bulk) {
        if (raw) {
          fn.call(elems, value);
          fn = null;
        } else {
          bulk = fn;
          fn = function(elem, key, value) {
            return bulk.call(jQuery(elem), value);
          };
        }
      }
      if (fn) {
        for (; i < len; i++) {
          fn(elems[i], key, raw ? value : value.call(elems[i], i, fn(elems[i], key)));
        }
      }
    }
    return chainable ? elems : bulk ? fn.call(elems) : len ? fn(elems[0], key) : emptyGet;
  };
  jQuery.acceptData = function(owner) {
    return owner.nodeType === 1 || owner.nodeType === 9 || !(+owner.nodeType);
  };
  function Data() {
    Object.defineProperty(this.cache = {}, 0, {get: function() {
        return {};
      }});
    this.expando = jQuery.expando + Data.uid++;
  }
  Data.uid = 1;
  Data.accepts = jQuery.acceptData;
  Data.prototype = {
    key: function(owner) {
      if (!Data.accepts(owner)) {
        return 0;
      }
      var descriptor = {},
          unlock = owner[this.expando];
      if (!unlock) {
        unlock = Data.uid++;
        try {
          descriptor[this.expando] = {value: unlock};
          Object.defineProperties(owner, descriptor);
        } catch (e) {
          descriptor[this.expando] = unlock;
          jQuery.extend(owner, descriptor);
        }
      }
      if (!this.cache[unlock]) {
        this.cache[unlock] = {};
      }
      return unlock;
    },
    set: function(owner, data, value) {
      var prop,
          unlock = this.key(owner),
          cache = this.cache[unlock];
      if (typeof data === "string") {
        cache[data] = value;
      } else {
        if (jQuery.isEmptyObject(cache)) {
          jQuery.extend(this.cache[unlock], data);
        } else {
          for (prop in data) {
            cache[prop] = data[prop];
          }
        }
      }
      return cache;
    },
    get: function(owner, key) {
      var cache = this.cache[this.key(owner)];
      return key === undefined ? cache : cache[key];
    },
    access: function(owner, key, value) {
      var stored;
      if (key === undefined || ((key && typeof key === "string") && value === undefined)) {
        stored = this.get(owner, key);
        return stored !== undefined ? stored : this.get(owner, jQuery.camelCase(key));
      }
      this.set(owner, key, value);
      return value !== undefined ? value : key;
    },
    remove: function(owner, key) {
      var i,
          name,
          camel,
          unlock = this.key(owner),
          cache = this.cache[unlock];
      if (key === undefined) {
        this.cache[unlock] = {};
      } else {
        if (jQuery.isArray(key)) {
          name = key.concat(key.map(jQuery.camelCase));
        } else {
          camel = jQuery.camelCase(key);
          if (key in cache) {
            name = [key, camel];
          } else {
            name = camel;
            name = name in cache ? [name] : (name.match(rnotwhite) || []);
          }
        }
        i = name.length;
        while (i--) {
          delete cache[name[i]];
        }
      }
    },
    hasData: function(owner) {
      return !jQuery.isEmptyObject(this.cache[owner[this.expando]] || {});
    },
    discard: function(owner) {
      if (owner[this.expando]) {
        delete this.cache[owner[this.expando]];
      }
    }
  };
  var data_priv = new Data();
  var data_user = new Data();
  var rbrace = /^(?:\{[\w\W]*\}|\[[\w\W]*\])$/,
      rmultiDash = /([A-Z])/g;
  function dataAttr(elem, key, data) {
    var name;
    if (data === undefined && elem.nodeType === 1) {
      name = "data-" + key.replace(rmultiDash, "-$1").toLowerCase();
      data = elem.getAttribute(name);
      if (typeof data === "string") {
        try {
          data = data === "true" ? true : data === "false" ? false : data === "null" ? null : +data + "" === data ? +data : rbrace.test(data) ? jQuery.parseJSON(data) : data;
        } catch (e) {}
        data_user.set(elem, key, data);
      } else {
        data = undefined;
      }
    }
    return data;
  }
  jQuery.extend({
    hasData: function(elem) {
      return data_user.hasData(elem) || data_priv.hasData(elem);
    },
    data: function(elem, name, data) {
      return data_user.access(elem, name, data);
    },
    removeData: function(elem, name) {
      data_user.remove(elem, name);
    },
    _data: function(elem, name, data) {
      return data_priv.access(elem, name, data);
    },
    _removeData: function(elem, name) {
      data_priv.remove(elem, name);
    }
  });
  jQuery.fn.extend({
    data: function(key, value) {
      var i,
          name,
          data,
          elem = this[0],
          attrs = elem && elem.attributes;
      if (key === undefined) {
        if (this.length) {
          data = data_user.get(elem);
          if (elem.nodeType === 1 && !data_priv.get(elem, "hasDataAttrs")) {
            i = attrs.length;
            while (i--) {
              if (attrs[i]) {
                name = attrs[i].name;
                if (name.indexOf("data-") === 0) {
                  name = jQuery.camelCase(name.slice(5));
                  dataAttr(elem, name, data[name]);
                }
              }
            }
            data_priv.set(elem, "hasDataAttrs", true);
          }
        }
        return data;
      }
      if (typeof key === "object") {
        return this.each(function() {
          data_user.set(this, key);
        });
      }
      return access(this, function(value) {
        var data,
            camelKey = jQuery.camelCase(key);
        if (elem && value === undefined) {
          data = data_user.get(elem, key);
          if (data !== undefined) {
            return data;
          }
          data = data_user.get(elem, camelKey);
          if (data !== undefined) {
            return data;
          }
          data = dataAttr(elem, camelKey, undefined);
          if (data !== undefined) {
            return data;
          }
          return ;
        }
        this.each(function() {
          var data = data_user.get(this, camelKey);
          data_user.set(this, camelKey, value);
          if (key.indexOf("-") !== -1 && data !== undefined) {
            data_user.set(this, key, value);
          }
        });
      }, null, value, arguments.length > 1, null, true);
    },
    removeData: function(key) {
      return this.each(function() {
        data_user.remove(this, key);
      });
    }
  });
  jQuery.extend({
    queue: function(elem, type, data) {
      var queue;
      if (elem) {
        type = (type || "fx") + "queue";
        queue = data_priv.get(elem, type);
        if (data) {
          if (!queue || jQuery.isArray(data)) {
            queue = data_priv.access(elem, type, jQuery.makeArray(data));
          } else {
            queue.push(data);
          }
        }
        return queue || [];
      }
    },
    dequeue: function(elem, type) {
      type = type || "fx";
      var queue = jQuery.queue(elem, type),
          startLength = queue.length,
          fn = queue.shift(),
          hooks = jQuery._queueHooks(elem, type),
          next = function() {
            jQuery.dequeue(elem, type);
          };
      if (fn === "inprogress") {
        fn = queue.shift();
        startLength--;
      }
      if (fn) {
        if (type === "fx") {
          queue.unshift("inprogress");
        }
        delete hooks.stop;
        fn.call(elem, next, hooks);
      }
      if (!startLength && hooks) {
        hooks.empty.fire();
      }
    },
    _queueHooks: function(elem, type) {
      var key = type + "queueHooks";
      return data_priv.get(elem, key) || data_priv.access(elem, key, {empty: jQuery.Callbacks("once memory").add(function() {
          data_priv.remove(elem, [type + "queue", key]);
        })});
    }
  });
  jQuery.fn.extend({
    queue: function(type, data) {
      var setter = 2;
      if (typeof type !== "string") {
        data = type;
        type = "fx";
        setter--;
      }
      if (arguments.length < setter) {
        return jQuery.queue(this[0], type);
      }
      return data === undefined ? this : this.each(function() {
        var queue = jQuery.queue(this, type, data);
        jQuery._queueHooks(this, type);
        if (type === "fx" && queue[0] !== "inprogress") {
          jQuery.dequeue(this, type);
        }
      });
    },
    dequeue: function(type) {
      return this.each(function() {
        jQuery.dequeue(this, type);
      });
    },
    clearQueue: function(type) {
      return this.queue(type || "fx", []);
    },
    promise: function(type, obj) {
      var tmp,
          count = 1,
          defer = jQuery.Deferred(),
          elements = this,
          i = this.length,
          resolve = function() {
            if (!(--count)) {
              defer.resolveWith(elements, [elements]);
            }
          };
      if (typeof type !== "string") {
        obj = type;
        type = undefined;
      }
      type = type || "fx";
      while (i--) {
        tmp = data_priv.get(elements[i], type + "queueHooks");
        if (tmp && tmp.empty) {
          count++;
          tmp.empty.add(resolve);
        }
      }
      resolve();
      return defer.promise(obj);
    }
  });
  var pnum = (/[+-]?(?:\d*\.|)\d+(?:[eE][+-]?\d+|)/).source;
  var cssExpand = ["Top", "Right", "Bottom", "Left"];
  var isHidden = function(elem, el) {
    elem = el || elem;
    return jQuery.css(elem, "display") === "none" || !jQuery.contains(elem.ownerDocument, elem);
  };
  var rcheckableType = (/^(?:checkbox|radio)$/i);
  (function() {
    var fragment = document.createDocumentFragment(),
        div = fragment.appendChild(document.createElement("div")),
        input = document.createElement("input");
    input.setAttribute("type", "radio");
    input.setAttribute("checked", "checked");
    input.setAttribute("name", "t");
    div.appendChild(input);
    support.checkClone = div.cloneNode(true).cloneNode(true).lastChild.checked;
    div.innerHTML = "<textarea>x</textarea>";
    support.noCloneChecked = !!div.cloneNode(true).lastChild.defaultValue;
  })();
  var strundefined = typeof undefined;
  support.focusinBubbles = "onfocusin" in window;
  var rkeyEvent = /^key/,
      rmouseEvent = /^(?:mouse|pointer|contextmenu)|click/,
      rfocusMorph = /^(?:focusinfocus|focusoutblur)$/,
      rtypenamespace = /^([^.]*)(?:\.(.+)|)$/;
  function returnTrue() {
    return true;
  }
  function returnFalse() {
    return false;
  }
  function safeActiveElement() {
    try {
      return document.activeElement;
    } catch (err) {}
  }
  jQuery.event = {
    global: {},
    add: function(elem, types, handler, data, selector) {
      var handleObjIn,
          eventHandle,
          tmp,
          events,
          t,
          handleObj,
          special,
          handlers,
          type,
          namespaces,
          origType,
          elemData = data_priv.get(elem);
      if (!elemData) {
        return ;
      }
      if (handler.handler) {
        handleObjIn = handler;
        handler = handleObjIn.handler;
        selector = handleObjIn.selector;
      }
      if (!handler.guid) {
        handler.guid = jQuery.guid++;
      }
      if (!(events = elemData.events)) {
        events = elemData.events = {};
      }
      if (!(eventHandle = elemData.handle)) {
        eventHandle = elemData.handle = function(e) {
          return typeof jQuery !== strundefined && jQuery.event.triggered !== e.type ? jQuery.event.dispatch.apply(elem, arguments) : undefined;
        };
      }
      types = (types || "").match(rnotwhite) || [""];
      t = types.length;
      while (t--) {
        tmp = rtypenamespace.exec(types[t]) || [];
        type = origType = tmp[1];
        namespaces = (tmp[2] || "").split(".").sort();
        if (!type) {
          continue;
        }
        special = jQuery.event.special[type] || {};
        type = (selector ? special.delegateType : special.bindType) || type;
        special = jQuery.event.special[type] || {};
        handleObj = jQuery.extend({
          type: type,
          origType: origType,
          data: data,
          handler: handler,
          guid: handler.guid,
          selector: selector,
          needsContext: selector && jQuery.expr.match.needsContext.test(selector),
          namespace: namespaces.join(".")
        }, handleObjIn);
        if (!(handlers = events[type])) {
          handlers = events[type] = [];
          handlers.delegateCount = 0;
          if (!special.setup || special.setup.call(elem, data, namespaces, eventHandle) === false) {
            if (elem.addEventListener) {
              elem.addEventListener(type, eventHandle, false);
            }
          }
        }
        if (special.add) {
          special.add.call(elem, handleObj);
          if (!handleObj.handler.guid) {
            handleObj.handler.guid = handler.guid;
          }
        }
        if (selector) {
          handlers.splice(handlers.delegateCount++, 0, handleObj);
        } else {
          handlers.push(handleObj);
        }
        jQuery.event.global[type] = true;
      }
    },
    remove: function(elem, types, handler, selector, mappedTypes) {
      var j,
          origCount,
          tmp,
          events,
          t,
          handleObj,
          special,
          handlers,
          type,
          namespaces,
          origType,
          elemData = data_priv.hasData(elem) && data_priv.get(elem);
      if (!elemData || !(events = elemData.events)) {
        return ;
      }
      types = (types || "").match(rnotwhite) || [""];
      t = types.length;
      while (t--) {
        tmp = rtypenamespace.exec(types[t]) || [];
        type = origType = tmp[1];
        namespaces = (tmp[2] || "").split(".").sort();
        if (!type) {
          for (type in events) {
            jQuery.event.remove(elem, type + types[t], handler, selector, true);
          }
          continue;
        }
        special = jQuery.event.special[type] || {};
        type = (selector ? special.delegateType : special.bindType) || type;
        handlers = events[type] || [];
        tmp = tmp[2] && new RegExp("(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)");
        origCount = j = handlers.length;
        while (j--) {
          handleObj = handlers[j];
          if ((mappedTypes || origType === handleObj.origType) && (!handler || handler.guid === handleObj.guid) && (!tmp || tmp.test(handleObj.namespace)) && (!selector || selector === handleObj.selector || selector === "**" && handleObj.selector)) {
            handlers.splice(j, 1);
            if (handleObj.selector) {
              handlers.delegateCount--;
            }
            if (special.remove) {
              special.remove.call(elem, handleObj);
            }
          }
        }
        if (origCount && !handlers.length) {
          if (!special.teardown || special.teardown.call(elem, namespaces, elemData.handle) === false) {
            jQuery.removeEvent(elem, type, elemData.handle);
          }
          delete events[type];
        }
      }
      if (jQuery.isEmptyObject(events)) {
        delete elemData.handle;
        data_priv.remove(elem, "events");
      }
    },
    trigger: function(event, data, elem, onlyHandlers) {
      var i,
          cur,
          tmp,
          bubbleType,
          ontype,
          handle,
          special,
          eventPath = [elem || document],
          type = hasOwn.call(event, "type") ? event.type : event,
          namespaces = hasOwn.call(event, "namespace") ? event.namespace.split(".") : [];
      cur = tmp = elem = elem || document;
      if (elem.nodeType === 3 || elem.nodeType === 8) {
        return ;
      }
      if (rfocusMorph.test(type + jQuery.event.triggered)) {
        return ;
      }
      if (type.indexOf(".") >= 0) {
        namespaces = type.split(".");
        type = namespaces.shift();
        namespaces.sort();
      }
      ontype = type.indexOf(":") < 0 && "on" + type;
      event = event[jQuery.expando] ? event : new jQuery.Event(type, typeof event === "object" && event);
      event.isTrigger = onlyHandlers ? 2 : 3;
      event.namespace = namespaces.join(".");
      event.namespace_re = event.namespace ? new RegExp("(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)") : null;
      event.result = undefined;
      if (!event.target) {
        event.target = elem;
      }
      data = data == null ? [event] : jQuery.makeArray(data, [event]);
      special = jQuery.event.special[type] || {};
      if (!onlyHandlers && special.trigger && special.trigger.apply(elem, data) === false) {
        return ;
      }
      if (!onlyHandlers && !special.noBubble && !jQuery.isWindow(elem)) {
        bubbleType = special.delegateType || type;
        if (!rfocusMorph.test(bubbleType + type)) {
          cur = cur.parentNode;
        }
        for (; cur; cur = cur.parentNode) {
          eventPath.push(cur);
          tmp = cur;
        }
        if (tmp === (elem.ownerDocument || document)) {
          eventPath.push(tmp.defaultView || tmp.parentWindow || window);
        }
      }
      i = 0;
      while ((cur = eventPath[i++]) && !event.isPropagationStopped()) {
        event.type = i > 1 ? bubbleType : special.bindType || type;
        handle = (data_priv.get(cur, "events") || {})[event.type] && data_priv.get(cur, "handle");
        if (handle) {
          handle.apply(cur, data);
        }
        handle = ontype && cur[ontype];
        if (handle && handle.apply && jQuery.acceptData(cur)) {
          event.result = handle.apply(cur, data);
          if (event.result === false) {
            event.preventDefault();
          }
        }
      }
      event.type = type;
      if (!onlyHandlers && !event.isDefaultPrevented()) {
        if ((!special._default || special._default.apply(eventPath.pop(), data) === false) && jQuery.acceptData(elem)) {
          if (ontype && jQuery.isFunction(elem[type]) && !jQuery.isWindow(elem)) {
            tmp = elem[ontype];
            if (tmp) {
              elem[ontype] = null;
            }
            jQuery.event.triggered = type;
            elem[type]();
            jQuery.event.triggered = undefined;
            if (tmp) {
              elem[ontype] = tmp;
            }
          }
        }
      }
      return event.result;
    },
    dispatch: function(event) {
      event = jQuery.event.fix(event);
      var i,
          j,
          ret,
          matched,
          handleObj,
          handlerQueue = [],
          args = slice.call(arguments),
          handlers = (data_priv.get(this, "events") || {})[event.type] || [],
          special = jQuery.event.special[event.type] || {};
      args[0] = event;
      event.delegateTarget = this;
      if (special.preDispatch && special.preDispatch.call(this, event) === false) {
        return ;
      }
      handlerQueue = jQuery.event.handlers.call(this, event, handlers);
      i = 0;
      while ((matched = handlerQueue[i++]) && !event.isPropagationStopped()) {
        event.currentTarget = matched.elem;
        j = 0;
        while ((handleObj = matched.handlers[j++]) && !event.isImmediatePropagationStopped()) {
          if (!event.namespace_re || event.namespace_re.test(handleObj.namespace)) {
            event.handleObj = handleObj;
            event.data = handleObj.data;
            ret = ((jQuery.event.special[handleObj.origType] || {}).handle || handleObj.handler).apply(matched.elem, args);
            if (ret !== undefined) {
              if ((event.result = ret) === false) {
                event.preventDefault();
                event.stopPropagation();
              }
            }
          }
        }
      }
      if (special.postDispatch) {
        special.postDispatch.call(this, event);
      }
      return event.result;
    },
    handlers: function(event, handlers) {
      var i,
          matches,
          sel,
          handleObj,
          handlerQueue = [],
          delegateCount = handlers.delegateCount,
          cur = event.target;
      if (delegateCount && cur.nodeType && (!event.button || event.type !== "click")) {
        for (; cur !== this; cur = cur.parentNode || this) {
          if (cur.disabled !== true || event.type !== "click") {
            matches = [];
            for (i = 0; i < delegateCount; i++) {
              handleObj = handlers[i];
              sel = handleObj.selector + " ";
              if (matches[sel] === undefined) {
                matches[sel] = handleObj.needsContext ? jQuery(sel, this).index(cur) >= 0 : jQuery.find(sel, this, null, [cur]).length;
              }
              if (matches[sel]) {
                matches.push(handleObj);
              }
            }
            if (matches.length) {
              handlerQueue.push({
                elem: cur,
                handlers: matches
              });
            }
          }
        }
      }
      if (delegateCount < handlers.length) {
        handlerQueue.push({
          elem: this,
          handlers: handlers.slice(delegateCount)
        });
      }
      return handlerQueue;
    },
    props: "altKey bubbles cancelable ctrlKey currentTarget eventPhase metaKey relatedTarget shiftKey target timeStamp view which".split(" "),
    fixHooks: {},
    keyHooks: {
      props: "char charCode key keyCode".split(" "),
      filter: function(event, original) {
        if (event.which == null) {
          event.which = original.charCode != null ? original.charCode : original.keyCode;
        }
        return event;
      }
    },
    mouseHooks: {
      props: "button buttons clientX clientY offsetX offsetY pageX pageY screenX screenY toElement".split(" "),
      filter: function(event, original) {
        var eventDoc,
            doc,
            body,
            button = original.button;
        if (event.pageX == null && original.clientX != null) {
          eventDoc = event.target.ownerDocument || document;
          doc = eventDoc.documentElement;
          body = eventDoc.body;
          event.pageX = original.clientX + (doc && doc.scrollLeft || body && body.scrollLeft || 0) - (doc && doc.clientLeft || body && body.clientLeft || 0);
          event.pageY = original.clientY + (doc && doc.scrollTop || body && body.scrollTop || 0) - (doc && doc.clientTop || body && body.clientTop || 0);
        }
        if (!event.which && button !== undefined) {
          event.which = (button & 1 ? 1 : (button & 2 ? 3 : (button & 4 ? 2 : 0)));
        }
        return event;
      }
    },
    fix: function(event) {
      if (event[jQuery.expando]) {
        return event;
      }
      var i,
          prop,
          copy,
          type = event.type,
          originalEvent = event,
          fixHook = this.fixHooks[type];
      if (!fixHook) {
        this.fixHooks[type] = fixHook = rmouseEvent.test(type) ? this.mouseHooks : rkeyEvent.test(type) ? this.keyHooks : {};
      }
      copy = fixHook.props ? this.props.concat(fixHook.props) : this.props;
      event = new jQuery.Event(originalEvent);
      i = copy.length;
      while (i--) {
        prop = copy[i];
        event[prop] = originalEvent[prop];
      }
      if (!event.target) {
        event.target = document;
      }
      if (event.target.nodeType === 3) {
        event.target = event.target.parentNode;
      }
      return fixHook.filter ? fixHook.filter(event, originalEvent) : event;
    },
    special: {
      load: {noBubble: true},
      focus: {
        trigger: function() {
          if (this !== safeActiveElement() && this.focus) {
            this.focus();
            return false;
          }
        },
        delegateType: "focusin"
      },
      blur: {
        trigger: function() {
          if (this === safeActiveElement() && this.blur) {
            this.blur();
            return false;
          }
        },
        delegateType: "focusout"
      },
      click: {
        trigger: function() {
          if (this.type === "checkbox" && this.click && jQuery.nodeName(this, "input")) {
            this.click();
            return false;
          }
        },
        _default: function(event) {
          return jQuery.nodeName(event.target, "a");
        }
      },
      beforeunload: {postDispatch: function(event) {
          if (event.result !== undefined && event.originalEvent) {
            event.originalEvent.returnValue = event.result;
          }
        }}
    },
    simulate: function(type, elem, event, bubble) {
      var e = jQuery.extend(new jQuery.Event(), event, {
        type: type,
        isSimulated: true,
        originalEvent: {}
      });
      if (bubble) {
        jQuery.event.trigger(e, null, elem);
      } else {
        jQuery.event.dispatch.call(elem, e);
      }
      if (e.isDefaultPrevented()) {
        event.preventDefault();
      }
    }
  };
  jQuery.removeEvent = function(elem, type, handle) {
    if (elem.removeEventListener) {
      elem.removeEventListener(type, handle, false);
    }
  };
  jQuery.Event = function(src, props) {
    if (!(this instanceof jQuery.Event)) {
      return new jQuery.Event(src, props);
    }
    if (src && src.type) {
      this.originalEvent = src;
      this.type = src.type;
      this.isDefaultPrevented = src.defaultPrevented || src.defaultPrevented === undefined && src.returnValue === false ? returnTrue : returnFalse;
    } else {
      this.type = src;
    }
    if (props) {
      jQuery.extend(this, props);
    }
    this.timeStamp = src && src.timeStamp || jQuery.now();
    this[jQuery.expando] = true;
  };
  jQuery.Event.prototype = {
    isDefaultPrevented: returnFalse,
    isPropagationStopped: returnFalse,
    isImmediatePropagationStopped: returnFalse,
    preventDefault: function() {
      var e = this.originalEvent;
      this.isDefaultPrevented = returnTrue;
      if (e && e.preventDefault) {
        e.preventDefault();
      }
    },
    stopPropagation: function() {
      var e = this.originalEvent;
      this.isPropagationStopped = returnTrue;
      if (e && e.stopPropagation) {
        e.stopPropagation();
      }
    },
    stopImmediatePropagation: function() {
      var e = this.originalEvent;
      this.isImmediatePropagationStopped = returnTrue;
      if (e && e.stopImmediatePropagation) {
        e.stopImmediatePropagation();
      }
      this.stopPropagation();
    }
  };
  jQuery.each({
    mouseenter: "mouseover",
    mouseleave: "mouseout",
    pointerenter: "pointerover",
    pointerleave: "pointerout"
  }, function(orig, fix) {
    jQuery.event.special[orig] = {
      delegateType: fix,
      bindType: fix,
      handle: function(event) {
        var ret,
            target = this,
            related = event.relatedTarget,
            handleObj = event.handleObj;
        if (!related || (related !== target && !jQuery.contains(target, related))) {
          event.type = handleObj.origType;
          ret = handleObj.handler.apply(this, arguments);
          event.type = fix;
        }
        return ret;
      }
    };
  });
  if (!support.focusinBubbles) {
    jQuery.each({
      focus: "focusin",
      blur: "focusout"
    }, function(orig, fix) {
      var handler = function(event) {
        jQuery.event.simulate(fix, event.target, jQuery.event.fix(event), true);
      };
      jQuery.event.special[fix] = {
        setup: function() {
          var doc = this.ownerDocument || this,
              attaches = data_priv.access(doc, fix);
          if (!attaches) {
            doc.addEventListener(orig, handler, true);
          }
          data_priv.access(doc, fix, (attaches || 0) + 1);
        },
        teardown: function() {
          var doc = this.ownerDocument || this,
              attaches = data_priv.access(doc, fix) - 1;
          if (!attaches) {
            doc.removeEventListener(orig, handler, true);
            data_priv.remove(doc, fix);
          } else {
            data_priv.access(doc, fix, attaches);
          }
        }
      };
    });
  }
  jQuery.fn.extend({
    on: function(types, selector, data, fn, one) {
      var origFn,
          type;
      if (typeof types === "object") {
        if (typeof selector !== "string") {
          data = data || selector;
          selector = undefined;
        }
        for (type in types) {
          this.on(type, selector, data, types[type], one);
        }
        return this;
      }
      if (data == null && fn == null) {
        fn = selector;
        data = selector = undefined;
      } else if (fn == null) {
        if (typeof selector === "string") {
          fn = data;
          data = undefined;
        } else {
          fn = data;
          data = selector;
          selector = undefined;
        }
      }
      if (fn === false) {
        fn = returnFalse;
      } else if (!fn) {
        return this;
      }
      if (one === 1) {
        origFn = fn;
        fn = function(event) {
          jQuery().off(event);
          return origFn.apply(this, arguments);
        };
        fn.guid = origFn.guid || (origFn.guid = jQuery.guid++);
      }
      return this.each(function() {
        jQuery.event.add(this, types, fn, data, selector);
      });
    },
    one: function(types, selector, data, fn) {
      return this.on(types, selector, data, fn, 1);
    },
    off: function(types, selector, fn) {
      var handleObj,
          type;
      if (types && types.preventDefault && types.handleObj) {
        handleObj = types.handleObj;
        jQuery(types.delegateTarget).off(handleObj.namespace ? handleObj.origType + "." + handleObj.namespace : handleObj.origType, handleObj.selector, handleObj.handler);
        return this;
      }
      if (typeof types === "object") {
        for (type in types) {
          this.off(type, selector, types[type]);
        }
        return this;
      }
      if (selector === false || typeof selector === "function") {
        fn = selector;
        selector = undefined;
      }
      if (fn === false) {
        fn = returnFalse;
      }
      return this.each(function() {
        jQuery.event.remove(this, types, fn, selector);
      });
    },
    trigger: function(type, data) {
      return this.each(function() {
        jQuery.event.trigger(type, data, this);
      });
    },
    triggerHandler: function(type, data) {
      var elem = this[0];
      if (elem) {
        return jQuery.event.trigger(type, data, elem, true);
      }
    }
  });
  var rxhtmlTag = /<(?!area|br|col|embed|hr|img|input|link|meta|param)(([\w:]+)[^>]*)\/>/gi,
      rtagName = /<([\w:]+)/,
      rhtml = /<|&#?\w+;/,
      rnoInnerhtml = /<(?:script|style|link)/i,
      rchecked = /checked\s*(?:[^=]|=\s*.checked.)/i,
      rscriptType = /^$|\/(?:java|ecma)script/i,
      rscriptTypeMasked = /^true\/(.*)/,
      rcleanScript = /^\s*<!(?:\[CDATA\[|--)|(?:\]\]|--)>\s*$/g,
      wrapMap = {
        option: [1, "<select multiple='multiple'>", "</select>"],
        thead: [1, "<table>", "</table>"],
        col: [2, "<table><colgroup>", "</colgroup></table>"],
        tr: [2, "<table><tbody>", "</tbody></table>"],
        td: [3, "<table><tbody><tr>", "</tr></tbody></table>"],
        _default: [0, "", ""]
      };
  wrapMap.optgroup = wrapMap.option;
  wrapMap.tbody = wrapMap.tfoot = wrapMap.colgroup = wrapMap.caption = wrapMap.thead;
  wrapMap.th = wrapMap.td;
  function manipulationTarget(elem, content) {
    return jQuery.nodeName(elem, "table") && jQuery.nodeName(content.nodeType !== 11 ? content : content.firstChild, "tr") ? elem.getElementsByTagName("tbody")[0] || elem.appendChild(elem.ownerDocument.createElement("tbody")) : elem;
  }
  function disableScript(elem) {
    elem.type = (elem.getAttribute("type") !== null) + "/" + elem.type;
    return elem;
  }
  function restoreScript(elem) {
    var match = rscriptTypeMasked.exec(elem.type);
    if (match) {
      elem.type = match[1];
    } else {
      elem.removeAttribute("type");
    }
    return elem;
  }
  function setGlobalEval(elems, refElements) {
    var i = 0,
        l = elems.length;
    for (; i < l; i++) {
      data_priv.set(elems[i], "globalEval", !refElements || data_priv.get(refElements[i], "globalEval"));
    }
  }
  function cloneCopyEvent(src, dest) {
    var i,
        l,
        type,
        pdataOld,
        pdataCur,
        udataOld,
        udataCur,
        events;
    if (dest.nodeType !== 1) {
      return ;
    }
    if (data_priv.hasData(src)) {
      pdataOld = data_priv.access(src);
      pdataCur = data_priv.set(dest, pdataOld);
      events = pdataOld.events;
      if (events) {
        delete pdataCur.handle;
        pdataCur.events = {};
        for (type in events) {
          for (i = 0, l = events[type].length; i < l; i++) {
            jQuery.event.add(dest, type, events[type][i]);
          }
        }
      }
    }
    if (data_user.hasData(src)) {
      udataOld = data_user.access(src);
      udataCur = jQuery.extend({}, udataOld);
      data_user.set(dest, udataCur);
    }
  }
  function getAll(context, tag) {
    var ret = context.getElementsByTagName ? context.getElementsByTagName(tag || "*") : context.querySelectorAll ? context.querySelectorAll(tag || "*") : [];
    return tag === undefined || tag && jQuery.nodeName(context, tag) ? jQuery.merge([context], ret) : ret;
  }
  function fixInput(src, dest) {
    var nodeName = dest.nodeName.toLowerCase();
    if (nodeName === "input" && rcheckableType.test(src.type)) {
      dest.checked = src.checked;
    } else if (nodeName === "input" || nodeName === "textarea") {
      dest.defaultValue = src.defaultValue;
    }
  }
  jQuery.extend({
    clone: function(elem, dataAndEvents, deepDataAndEvents) {
      var i,
          l,
          srcElements,
          destElements,
          clone = elem.cloneNode(true),
          inPage = jQuery.contains(elem.ownerDocument, elem);
      if (!support.noCloneChecked && (elem.nodeType === 1 || elem.nodeType === 11) && !jQuery.isXMLDoc(elem)) {
        destElements = getAll(clone);
        srcElements = getAll(elem);
        for (i = 0, l = srcElements.length; i < l; i++) {
          fixInput(srcElements[i], destElements[i]);
        }
      }
      if (dataAndEvents) {
        if (deepDataAndEvents) {
          srcElements = srcElements || getAll(elem);
          destElements = destElements || getAll(clone);
          for (i = 0, l = srcElements.length; i < l; i++) {
            cloneCopyEvent(srcElements[i], destElements[i]);
          }
        } else {
          cloneCopyEvent(elem, clone);
        }
      }
      destElements = getAll(clone, "script");
      if (destElements.length > 0) {
        setGlobalEval(destElements, !inPage && getAll(elem, "script"));
      }
      return clone;
    },
    buildFragment: function(elems, context, scripts, selection) {
      var elem,
          tmp,
          tag,
          wrap,
          contains,
          j,
          fragment = context.createDocumentFragment(),
          nodes = [],
          i = 0,
          l = elems.length;
      for (; i < l; i++) {
        elem = elems[i];
        if (elem || elem === 0) {
          if (jQuery.type(elem) === "object") {
            jQuery.merge(nodes, elem.nodeType ? [elem] : elem);
          } else if (!rhtml.test(elem)) {
            nodes.push(context.createTextNode(elem));
          } else {
            tmp = tmp || fragment.appendChild(context.createElement("div"));
            tag = (rtagName.exec(elem) || ["", ""])[1].toLowerCase();
            wrap = wrapMap[tag] || wrapMap._default;
            tmp.innerHTML = wrap[1] + elem.replace(rxhtmlTag, "<$1></$2>") + wrap[2];
            j = wrap[0];
            while (j--) {
              tmp = tmp.lastChild;
            }
            jQuery.merge(nodes, tmp.childNodes);
            tmp = fragment.firstChild;
            tmp.textContent = "";
          }
        }
      }
      fragment.textContent = "";
      i = 0;
      while ((elem = nodes[i++])) {
        if (selection && jQuery.inArray(elem, selection) !== -1) {
          continue;
        }
        contains = jQuery.contains(elem.ownerDocument, elem);
        tmp = getAll(fragment.appendChild(elem), "script");
        if (contains) {
          setGlobalEval(tmp);
        }
        if (scripts) {
          j = 0;
          while ((elem = tmp[j++])) {
            if (rscriptType.test(elem.type || "")) {
              scripts.push(elem);
            }
          }
        }
      }
      return fragment;
    },
    cleanData: function(elems) {
      var data,
          elem,
          type,
          key,
          special = jQuery.event.special,
          i = 0;
      for (; (elem = elems[i]) !== undefined; i++) {
        if (jQuery.acceptData(elem)) {
          key = elem[data_priv.expando];
          if (key && (data = data_priv.cache[key])) {
            if (data.events) {
              for (type in data.events) {
                if (special[type]) {
                  jQuery.event.remove(elem, type);
                } else {
                  jQuery.removeEvent(elem, type, data.handle);
                }
              }
            }
            if (data_priv.cache[key]) {
              delete data_priv.cache[key];
            }
          }
        }
        delete data_user.cache[elem[data_user.expando]];
      }
    }
  });
  jQuery.fn.extend({
    text: function(value) {
      return access(this, function(value) {
        return value === undefined ? jQuery.text(this) : this.empty().each(function() {
          if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
            this.textContent = value;
          }
        });
      }, null, value, arguments.length);
    },
    append: function() {
      return this.domManip(arguments, function(elem) {
        if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
          var target = manipulationTarget(this, elem);
          target.appendChild(elem);
        }
      });
    },
    prepend: function() {
      return this.domManip(arguments, function(elem) {
        if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
          var target = manipulationTarget(this, elem);
          target.insertBefore(elem, target.firstChild);
        }
      });
    },
    before: function() {
      return this.domManip(arguments, function(elem) {
        if (this.parentNode) {
          this.parentNode.insertBefore(elem, this);
        }
      });
    },
    after: function() {
      return this.domManip(arguments, function(elem) {
        if (this.parentNode) {
          this.parentNode.insertBefore(elem, this.nextSibling);
        }
      });
    },
    remove: function(selector, keepData) {
      var elem,
          elems = selector ? jQuery.filter(selector, this) : this,
          i = 0;
      for (; (elem = elems[i]) != null; i++) {
        if (!keepData && elem.nodeType === 1) {
          jQuery.cleanData(getAll(elem));
        }
        if (elem.parentNode) {
          if (keepData && jQuery.contains(elem.ownerDocument, elem)) {
            setGlobalEval(getAll(elem, "script"));
          }
          elem.parentNode.removeChild(elem);
        }
      }
      return this;
    },
    empty: function() {
      var elem,
          i = 0;
      for (; (elem = this[i]) != null; i++) {
        if (elem.nodeType === 1) {
          jQuery.cleanData(getAll(elem, false));
          elem.textContent = "";
        }
      }
      return this;
    },
    clone: function(dataAndEvents, deepDataAndEvents) {
      dataAndEvents = dataAndEvents == null ? false : dataAndEvents;
      deepDataAndEvents = deepDataAndEvents == null ? dataAndEvents : deepDataAndEvents;
      return this.map(function() {
        return jQuery.clone(this, dataAndEvents, deepDataAndEvents);
      });
    },
    html: function(value) {
      return access(this, function(value) {
        var elem = this[0] || {},
            i = 0,
            l = this.length;
        if (value === undefined && elem.nodeType === 1) {
          return elem.innerHTML;
        }
        if (typeof value === "string" && !rnoInnerhtml.test(value) && !wrapMap[(rtagName.exec(value) || ["", ""])[1].toLowerCase()]) {
          value = value.replace(rxhtmlTag, "<$1></$2>");
          try {
            for (; i < l; i++) {
              elem = this[i] || {};
              if (elem.nodeType === 1) {
                jQuery.cleanData(getAll(elem, false));
                elem.innerHTML = value;
              }
            }
            elem = 0;
          } catch (e) {}
        }
        if (elem) {
          this.empty().append(value);
        }
      }, null, value, arguments.length);
    },
    replaceWith: function() {
      var arg = arguments[0];
      this.domManip(arguments, function(elem) {
        arg = this.parentNode;
        jQuery.cleanData(getAll(this));
        if (arg) {
          arg.replaceChild(elem, this);
        }
      });
      return arg && (arg.length || arg.nodeType) ? this : this.remove();
    },
    detach: function(selector) {
      return this.remove(selector, true);
    },
    domManip: function(args, callback) {
      args = concat.apply([], args);
      var fragment,
          first,
          scripts,
          hasScripts,
          node,
          doc,
          i = 0,
          l = this.length,
          set = this,
          iNoClone = l - 1,
          value = args[0],
          isFunction = jQuery.isFunction(value);
      if (isFunction || (l > 1 && typeof value === "string" && !support.checkClone && rchecked.test(value))) {
        return this.each(function(index) {
          var self = set.eq(index);
          if (isFunction) {
            args[0] = value.call(this, index, self.html());
          }
          self.domManip(args, callback);
        });
      }
      if (l) {
        fragment = jQuery.buildFragment(args, this[0].ownerDocument, false, this);
        first = fragment.firstChild;
        if (fragment.childNodes.length === 1) {
          fragment = first;
        }
        if (first) {
          scripts = jQuery.map(getAll(fragment, "script"), disableScript);
          hasScripts = scripts.length;
          for (; i < l; i++) {
            node = fragment;
            if (i !== iNoClone) {
              node = jQuery.clone(node, true, true);
              if (hasScripts) {
                jQuery.merge(scripts, getAll(node, "script"));
              }
            }
            callback.call(this[i], node, i);
          }
          if (hasScripts) {
            doc = scripts[scripts.length - 1].ownerDocument;
            jQuery.map(scripts, restoreScript);
            for (i = 0; i < hasScripts; i++) {
              node = scripts[i];
              if (rscriptType.test(node.type || "") && !data_priv.access(node, "globalEval") && jQuery.contains(doc, node)) {
                if (node.src) {
                  if (jQuery._evalUrl) {
                    jQuery._evalUrl(node.src);
                  }
                } else {
                  jQuery.globalEval(node.textContent.replace(rcleanScript, ""));
                }
              }
            }
          }
        }
      }
      return this;
    }
  });
  jQuery.each({
    appendTo: "append",
    prependTo: "prepend",
    insertBefore: "before",
    insertAfter: "after",
    replaceAll: "replaceWith"
  }, function(name, original) {
    jQuery.fn[name] = function(selector) {
      var elems,
          ret = [],
          insert = jQuery(selector),
          last = insert.length - 1,
          i = 0;
      for (; i <= last; i++) {
        elems = i === last ? this : this.clone(true);
        jQuery(insert[i])[original](elems);
        push.apply(ret, elems.get());
      }
      return this.pushStack(ret);
    };
  });
  var iframe,
      elemdisplay = {};
  function actualDisplay(name, doc) {
    var style,
        elem = jQuery(doc.createElement(name)).appendTo(doc.body),
        display = window.getDefaultComputedStyle && (style = window.getDefaultComputedStyle(elem[0])) ? style.display : jQuery.css(elem[0], "display");
    elem.detach();
    return display;
  }
  function defaultDisplay(nodeName) {
    var doc = document,
        display = elemdisplay[nodeName];
    if (!display) {
      display = actualDisplay(nodeName, doc);
      if (display === "none" || !display) {
        iframe = (iframe || jQuery("<iframe frameborder='0' width='0' height='0'/>")).appendTo(doc.documentElement);
        doc = iframe[0].contentDocument;
        doc.write();
        doc.close();
        display = actualDisplay(nodeName, doc);
        iframe.detach();
      }
      elemdisplay[nodeName] = display;
    }
    return display;
  }
  var rmargin = (/^margin/);
  var rnumnonpx = new RegExp("^(" + pnum + ")(?!px)[a-z%]+$", "i");
  var getStyles = function(elem) {
    if (elem.ownerDocument.defaultView.opener) {
      return elem.ownerDocument.defaultView.getComputedStyle(elem, null);
    }
    return window.getComputedStyle(elem, null);
  };
  function curCSS(elem, name, computed) {
    var width,
        minWidth,
        maxWidth,
        ret,
        style = elem.style;
    computed = computed || getStyles(elem);
    if (computed) {
      ret = computed.getPropertyValue(name) || computed[name];
    }
    if (computed) {
      if (ret === "" && !jQuery.contains(elem.ownerDocument, elem)) {
        ret = jQuery.style(elem, name);
      }
      if (rnumnonpx.test(ret) && rmargin.test(name)) {
        width = style.width;
        minWidth = style.minWidth;
        maxWidth = style.maxWidth;
        style.minWidth = style.maxWidth = style.width = ret;
        ret = computed.width;
        style.width = width;
        style.minWidth = minWidth;
        style.maxWidth = maxWidth;
      }
    }
    return ret !== undefined ? ret + "" : ret;
  }
  function addGetHookIf(conditionFn, hookFn) {
    return {get: function() {
        if (conditionFn()) {
          delete this.get;
          return ;
        }
        return (this.get = hookFn).apply(this, arguments);
      }};
  }
  (function() {
    var pixelPositionVal,
        boxSizingReliableVal,
        docElem = document.documentElement,
        container = document.createElement("div"),
        div = document.createElement("div");
    if (!div.style) {
      return ;
    }
    div.style.backgroundClip = "content-box";
    div.cloneNode(true).style.backgroundClip = "";
    support.clearCloneStyle = div.style.backgroundClip === "content-box";
    container.style.cssText = "border:0;width:0;height:0;top:0;left:-9999px;margin-top:1px;" + "position:absolute";
    container.appendChild(div);
    function computePixelPositionAndBoxSizingReliable() {
      div.style.cssText = "-webkit-box-sizing:border-box;-moz-box-sizing:border-box;" + "box-sizing:border-box;display:block;margin-top:1%;top:1%;" + "border:1px;padding:1px;width:4px;position:absolute";
      div.innerHTML = "";
      docElem.appendChild(container);
      var divStyle = window.getComputedStyle(div, null);
      pixelPositionVal = divStyle.top !== "1%";
      boxSizingReliableVal = divStyle.width === "4px";
      docElem.removeChild(container);
    }
    if (window.getComputedStyle) {
      jQuery.extend(support, {
        pixelPosition: function() {
          computePixelPositionAndBoxSizingReliable();
          return pixelPositionVal;
        },
        boxSizingReliable: function() {
          if (boxSizingReliableVal == null) {
            computePixelPositionAndBoxSizingReliable();
          }
          return boxSizingReliableVal;
        },
        reliableMarginRight: function() {
          var ret,
              marginDiv = div.appendChild(document.createElement("div"));
          marginDiv.style.cssText = div.style.cssText = "-webkit-box-sizing:content-box;-moz-box-sizing:content-box;" + "box-sizing:content-box;display:block;margin:0;border:0;padding:0";
          marginDiv.style.marginRight = marginDiv.style.width = "0";
          div.style.width = "1px";
          docElem.appendChild(container);
          ret = !parseFloat(window.getComputedStyle(marginDiv, null).marginRight);
          docElem.removeChild(container);
          div.removeChild(marginDiv);
          return ret;
        }
      });
    }
  })();
  jQuery.swap = function(elem, options, callback, args) {
    var ret,
        name,
        old = {};
    for (name in options) {
      old[name] = elem.style[name];
      elem.style[name] = options[name];
    }
    ret = callback.apply(elem, args || []);
    for (name in options) {
      elem.style[name] = old[name];
    }
    return ret;
  };
  var rdisplayswap = /^(none|table(?!-c[ea]).+)/,
      rnumsplit = new RegExp("^(" + pnum + ")(.*)$", "i"),
      rrelNum = new RegExp("^([+-])=(" + pnum + ")", "i"),
      cssShow = {
        position: "absolute",
        visibility: "hidden",
        display: "block"
      },
      cssNormalTransform = {
        letterSpacing: "0",
        fontWeight: "400"
      },
      cssPrefixes = ["Webkit", "O", "Moz", "ms"];
  function vendorPropName(style, name) {
    if (name in style) {
      return name;
    }
    var capName = name[0].toUpperCase() + name.slice(1),
        origName = name,
        i = cssPrefixes.length;
    while (i--) {
      name = cssPrefixes[i] + capName;
      if (name in style) {
        return name;
      }
    }
    return origName;
  }
  function setPositiveNumber(elem, value, subtract) {
    var matches = rnumsplit.exec(value);
    return matches ? Math.max(0, matches[1] - (subtract || 0)) + (matches[2] || "px") : value;
  }
  function augmentWidthOrHeight(elem, name, extra, isBorderBox, styles) {
    var i = extra === (isBorderBox ? "border" : "content") ? 4 : name === "width" ? 1 : 0,
        val = 0;
    for (; i < 4; i += 2) {
      if (extra === "margin") {
        val += jQuery.css(elem, extra + cssExpand[i], true, styles);
      }
      if (isBorderBox) {
        if (extra === "content") {
          val -= jQuery.css(elem, "padding" + cssExpand[i], true, styles);
        }
        if (extra !== "margin") {
          val -= jQuery.css(elem, "border" + cssExpand[i] + "Width", true, styles);
        }
      } else {
        val += jQuery.css(elem, "padding" + cssExpand[i], true, styles);
        if (extra !== "padding") {
          val += jQuery.css(elem, "border" + cssExpand[i] + "Width", true, styles);
        }
      }
    }
    return val;
  }
  function getWidthOrHeight(elem, name, extra) {
    var valueIsBorderBox = true,
        val = name === "width" ? elem.offsetWidth : elem.offsetHeight,
        styles = getStyles(elem),
        isBorderBox = jQuery.css(elem, "boxSizing", false, styles) === "border-box";
    if (val <= 0 || val == null) {
      val = curCSS(elem, name, styles);
      if (val < 0 || val == null) {
        val = elem.style[name];
      }
      if (rnumnonpx.test(val)) {
        return val;
      }
      valueIsBorderBox = isBorderBox && (support.boxSizingReliable() || val === elem.style[name]);
      val = parseFloat(val) || 0;
    }
    return (val + augmentWidthOrHeight(elem, name, extra || (isBorderBox ? "border" : "content"), valueIsBorderBox, styles)) + "px";
  }
  function showHide(elements, show) {
    var display,
        elem,
        hidden,
        values = [],
        index = 0,
        length = elements.length;
    for (; index < length; index++) {
      elem = elements[index];
      if (!elem.style) {
        continue;
      }
      values[index] = data_priv.get(elem, "olddisplay");
      display = elem.style.display;
      if (show) {
        if (!values[index] && display === "none") {
          elem.style.display = "";
        }
        if (elem.style.display === "" && isHidden(elem)) {
          values[index] = data_priv.access(elem, "olddisplay", defaultDisplay(elem.nodeName));
        }
      } else {
        hidden = isHidden(elem);
        if (display !== "none" || !hidden) {
          data_priv.set(elem, "olddisplay", hidden ? display : jQuery.css(elem, "display"));
        }
      }
    }
    for (index = 0; index < length; index++) {
      elem = elements[index];
      if (!elem.style) {
        continue;
      }
      if (!show || elem.style.display === "none" || elem.style.display === "") {
        elem.style.display = show ? values[index] || "" : "none";
      }
    }
    return elements;
  }
  jQuery.extend({
    cssHooks: {opacity: {get: function(elem, computed) {
          if (computed) {
            var ret = curCSS(elem, "opacity");
            return ret === "" ? "1" : ret;
          }
        }}},
    cssNumber: {
      "columnCount": true,
      "fillOpacity": true,
      "flexGrow": true,
      "flexShrink": true,
      "fontWeight": true,
      "lineHeight": true,
      "opacity": true,
      "order": true,
      "orphans": true,
      "widows": true,
      "zIndex": true,
      "zoom": true
    },
    cssProps: {"float": "cssFloat"},
    style: function(elem, name, value, extra) {
      if (!elem || elem.nodeType === 3 || elem.nodeType === 8 || !elem.style) {
        return ;
      }
      var ret,
          type,
          hooks,
          origName = jQuery.camelCase(name),
          style = elem.style;
      name = jQuery.cssProps[origName] || (jQuery.cssProps[origName] = vendorPropName(style, origName));
      hooks = jQuery.cssHooks[name] || jQuery.cssHooks[origName];
      if (value !== undefined) {
        type = typeof value;
        if (type === "string" && (ret = rrelNum.exec(value))) {
          value = (ret[1] + 1) * ret[2] + parseFloat(jQuery.css(elem, name));
          type = "number";
        }
        if (value == null || value !== value) {
          return ;
        }
        if (type === "number" && !jQuery.cssNumber[origName]) {
          value += "px";
        }
        if (!support.clearCloneStyle && value === "" && name.indexOf("background") === 0) {
          style[name] = "inherit";
        }
        if (!hooks || !("set" in hooks) || (value = hooks.set(elem, value, extra)) !== undefined) {
          style[name] = value;
        }
      } else {
        if (hooks && "get" in hooks && (ret = hooks.get(elem, false, extra)) !== undefined) {
          return ret;
        }
        return style[name];
      }
    },
    css: function(elem, name, extra, styles) {
      var val,
          num,
          hooks,
          origName = jQuery.camelCase(name);
      name = jQuery.cssProps[origName] || (jQuery.cssProps[origName] = vendorPropName(elem.style, origName));
      hooks = jQuery.cssHooks[name] || jQuery.cssHooks[origName];
      if (hooks && "get" in hooks) {
        val = hooks.get(elem, true, extra);
      }
      if (val === undefined) {
        val = curCSS(elem, name, styles);
      }
      if (val === "normal" && name in cssNormalTransform) {
        val = cssNormalTransform[name];
      }
      if (extra === "" || extra) {
        num = parseFloat(val);
        return extra === true || jQuery.isNumeric(num) ? num || 0 : val;
      }
      return val;
    }
  });
  jQuery.each(["height", "width"], function(i, name) {
    jQuery.cssHooks[name] = {
      get: function(elem, computed, extra) {
        if (computed) {
          return rdisplayswap.test(jQuery.css(elem, "display")) && elem.offsetWidth === 0 ? jQuery.swap(elem, cssShow, function() {
            return getWidthOrHeight(elem, name, extra);
          }) : getWidthOrHeight(elem, name, extra);
        }
      },
      set: function(elem, value, extra) {
        var styles = extra && getStyles(elem);
        return setPositiveNumber(elem, value, extra ? augmentWidthOrHeight(elem, name, extra, jQuery.css(elem, "boxSizing", false, styles) === "border-box", styles) : 0);
      }
    };
  });
  jQuery.cssHooks.marginRight = addGetHookIf(support.reliableMarginRight, function(elem, computed) {
    if (computed) {
      return jQuery.swap(elem, {"display": "inline-block"}, curCSS, [elem, "marginRight"]);
    }
  });
  jQuery.each({
    margin: "",
    padding: "",
    border: "Width"
  }, function(prefix, suffix) {
    jQuery.cssHooks[prefix + suffix] = {expand: function(value) {
        var i = 0,
            expanded = {},
            parts = typeof value === "string" ? value.split(" ") : [value];
        for (; i < 4; i++) {
          expanded[prefix + cssExpand[i] + suffix] = parts[i] || parts[i - 2] || parts[0];
        }
        return expanded;
      }};
    if (!rmargin.test(prefix)) {
      jQuery.cssHooks[prefix + suffix].set = setPositiveNumber;
    }
  });
  jQuery.fn.extend({
    css: function(name, value) {
      return access(this, function(elem, name, value) {
        var styles,
            len,
            map = {},
            i = 0;
        if (jQuery.isArray(name)) {
          styles = getStyles(elem);
          len = name.length;
          for (; i < len; i++) {
            map[name[i]] = jQuery.css(elem, name[i], false, styles);
          }
          return map;
        }
        return value !== undefined ? jQuery.style(elem, name, value) : jQuery.css(elem, name);
      }, name, value, arguments.length > 1);
    },
    show: function() {
      return showHide(this, true);
    },
    hide: function() {
      return showHide(this);
    },
    toggle: function(state) {
      if (typeof state === "boolean") {
        return state ? this.show() : this.hide();
      }
      return this.each(function() {
        if (isHidden(this)) {
          jQuery(this).show();
        } else {
          jQuery(this).hide();
        }
      });
    }
  });
  function Tween(elem, options, prop, end, easing) {
    return new Tween.prototype.init(elem, options, prop, end, easing);
  }
  jQuery.Tween = Tween;
  Tween.prototype = {
    constructor: Tween,
    init: function(elem, options, prop, end, easing, unit) {
      this.elem = elem;
      this.prop = prop;
      this.easing = easing || "swing";
      this.options = options;
      this.start = this.now = this.cur();
      this.end = end;
      this.unit = unit || (jQuery.cssNumber[prop] ? "" : "px");
    },
    cur: function() {
      var hooks = Tween.propHooks[this.prop];
      return hooks && hooks.get ? hooks.get(this) : Tween.propHooks._default.get(this);
    },
    run: function(percent) {
      var eased,
          hooks = Tween.propHooks[this.prop];
      if (this.options.duration) {
        this.pos = eased = jQuery.easing[this.easing](percent, this.options.duration * percent, 0, 1, this.options.duration);
      } else {
        this.pos = eased = percent;
      }
      this.now = (this.end - this.start) * eased + this.start;
      if (this.options.step) {
        this.options.step.call(this.elem, this.now, this);
      }
      if (hooks && hooks.set) {
        hooks.set(this);
      } else {
        Tween.propHooks._default.set(this);
      }
      return this;
    }
  };
  Tween.prototype.init.prototype = Tween.prototype;
  Tween.propHooks = {_default: {
      get: function(tween) {
        var result;
        if (tween.elem[tween.prop] != null && (!tween.elem.style || tween.elem.style[tween.prop] == null)) {
          return tween.elem[tween.prop];
        }
        result = jQuery.css(tween.elem, tween.prop, "");
        return !result || result === "auto" ? 0 : result;
      },
      set: function(tween) {
        if (jQuery.fx.step[tween.prop]) {
          jQuery.fx.step[tween.prop](tween);
        } else if (tween.elem.style && (tween.elem.style[jQuery.cssProps[tween.prop]] != null || jQuery.cssHooks[tween.prop])) {
          jQuery.style(tween.elem, tween.prop, tween.now + tween.unit);
        } else {
          tween.elem[tween.prop] = tween.now;
        }
      }
    }};
  Tween.propHooks.scrollTop = Tween.propHooks.scrollLeft = {set: function(tween) {
      if (tween.elem.nodeType && tween.elem.parentNode) {
        tween.elem[tween.prop] = tween.now;
      }
    }};
  jQuery.easing = {
    linear: function(p) {
      return p;
    },
    swing: function(p) {
      return 0.5 - Math.cos(p * Math.PI) / 2;
    }
  };
  jQuery.fx = Tween.prototype.init;
  jQuery.fx.step = {};
  var fxNow,
      timerId,
      rfxtypes = /^(?:toggle|show|hide)$/,
      rfxnum = new RegExp("^(?:([+-])=|)(" + pnum + ")([a-z%]*)$", "i"),
      rrun = /queueHooks$/,
      animationPrefilters = [defaultPrefilter],
      tweeners = {"*": [function(prop, value) {
          var tween = this.createTween(prop, value),
              target = tween.cur(),
              parts = rfxnum.exec(value),
              unit = parts && parts[3] || (jQuery.cssNumber[prop] ? "" : "px"),
              start = (jQuery.cssNumber[prop] || unit !== "px" && +target) && rfxnum.exec(jQuery.css(tween.elem, prop)),
              scale = 1,
              maxIterations = 20;
          if (start && start[3] !== unit) {
            unit = unit || start[3];
            parts = parts || [];
            start = +target || 1;
            do {
              scale = scale || ".5";
              start = start / scale;
              jQuery.style(tween.elem, prop, start + unit);
            } while (scale !== (scale = tween.cur() / target) && scale !== 1 && --maxIterations);
          }
          if (parts) {
            start = tween.start = +start || +target || 0;
            tween.unit = unit;
            tween.end = parts[1] ? start + (parts[1] + 1) * parts[2] : +parts[2];
          }
          return tween;
        }]};
  function createFxNow() {
    setTimeout(function() {
      fxNow = undefined;
    });
    return (fxNow = jQuery.now());
  }
  function genFx(type, includeWidth) {
    var which,
        i = 0,
        attrs = {height: type};
    includeWidth = includeWidth ? 1 : 0;
    for (; i < 4; i += 2 - includeWidth) {
      which = cssExpand[i];
      attrs["margin" + which] = attrs["padding" + which] = type;
    }
    if (includeWidth) {
      attrs.opacity = attrs.width = type;
    }
    return attrs;
  }
  function createTween(value, prop, animation) {
    var tween,
        collection = (tweeners[prop] || []).concat(tweeners["*"]),
        index = 0,
        length = collection.length;
    for (; index < length; index++) {
      if ((tween = collection[index].call(animation, prop, value))) {
        return tween;
      }
    }
  }
  function defaultPrefilter(elem, props, opts) {
    var prop,
        value,
        toggle,
        tween,
        hooks,
        oldfire,
        display,
        checkDisplay,
        anim = this,
        orig = {},
        style = elem.style,
        hidden = elem.nodeType && isHidden(elem),
        dataShow = data_priv.get(elem, "fxshow");
    if (!opts.queue) {
      hooks = jQuery._queueHooks(elem, "fx");
      if (hooks.unqueued == null) {
        hooks.unqueued = 0;
        oldfire = hooks.empty.fire;
        hooks.empty.fire = function() {
          if (!hooks.unqueued) {
            oldfire();
          }
        };
      }
      hooks.unqueued++;
      anim.always(function() {
        anim.always(function() {
          hooks.unqueued--;
          if (!jQuery.queue(elem, "fx").length) {
            hooks.empty.fire();
          }
        });
      });
    }
    if (elem.nodeType === 1 && ("height" in props || "width" in props)) {
      opts.overflow = [style.overflow, style.overflowX, style.overflowY];
      display = jQuery.css(elem, "display");
      checkDisplay = display === "none" ? data_priv.get(elem, "olddisplay") || defaultDisplay(elem.nodeName) : display;
      if (checkDisplay === "inline" && jQuery.css(elem, "float") === "none") {
        style.display = "inline-block";
      }
    }
    if (opts.overflow) {
      style.overflow = "hidden";
      anim.always(function() {
        style.overflow = opts.overflow[0];
        style.overflowX = opts.overflow[1];
        style.overflowY = opts.overflow[2];
      });
    }
    for (prop in props) {
      value = props[prop];
      if (rfxtypes.exec(value)) {
        delete props[prop];
        toggle = toggle || value === "toggle";
        if (value === (hidden ? "hide" : "show")) {
          if (value === "show" && dataShow && dataShow[prop] !== undefined) {
            hidden = true;
          } else {
            continue;
          }
        }
        orig[prop] = dataShow && dataShow[prop] || jQuery.style(elem, prop);
      } else {
        display = undefined;
      }
    }
    if (!jQuery.isEmptyObject(orig)) {
      if (dataShow) {
        if ("hidden" in dataShow) {
          hidden = dataShow.hidden;
        }
      } else {
        dataShow = data_priv.access(elem, "fxshow", {});
      }
      if (toggle) {
        dataShow.hidden = !hidden;
      }
      if (hidden) {
        jQuery(elem).show();
      } else {
        anim.done(function() {
          jQuery(elem).hide();
        });
      }
      anim.done(function() {
        var prop;
        data_priv.remove(elem, "fxshow");
        for (prop in orig) {
          jQuery.style(elem, prop, orig[prop]);
        }
      });
      for (prop in orig) {
        tween = createTween(hidden ? dataShow[prop] : 0, prop, anim);
        if (!(prop in dataShow)) {
          dataShow[prop] = tween.start;
          if (hidden) {
            tween.end = tween.start;
            tween.start = prop === "width" || prop === "height" ? 1 : 0;
          }
        }
      }
    } else if ((display === "none" ? defaultDisplay(elem.nodeName) : display) === "inline") {
      style.display = display;
    }
  }
  function propFilter(props, specialEasing) {
    var index,
        name,
        easing,
        value,
        hooks;
    for (index in props) {
      name = jQuery.camelCase(index);
      easing = specialEasing[name];
      value = props[index];
      if (jQuery.isArray(value)) {
        easing = value[1];
        value = props[index] = value[0];
      }
      if (index !== name) {
        props[name] = value;
        delete props[index];
      }
      hooks = jQuery.cssHooks[name];
      if (hooks && "expand" in hooks) {
        value = hooks.expand(value);
        delete props[name];
        for (index in value) {
          if (!(index in props)) {
            props[index] = value[index];
            specialEasing[index] = easing;
          }
        }
      } else {
        specialEasing[name] = easing;
      }
    }
  }
  function Animation(elem, properties, options) {
    var result,
        stopped,
        index = 0,
        length = animationPrefilters.length,
        deferred = jQuery.Deferred().always(function() {
          delete tick.elem;
        }),
        tick = function() {
          if (stopped) {
            return false;
          }
          var currentTime = fxNow || createFxNow(),
              remaining = Math.max(0, animation.startTime + animation.duration - currentTime),
              temp = remaining / animation.duration || 0,
              percent = 1 - temp,
              index = 0,
              length = animation.tweens.length;
          for (; index < length; index++) {
            animation.tweens[index].run(percent);
          }
          deferred.notifyWith(elem, [animation, percent, remaining]);
          if (percent < 1 && length) {
            return remaining;
          } else {
            deferred.resolveWith(elem, [animation]);
            return false;
          }
        },
        animation = deferred.promise({
          elem: elem,
          props: jQuery.extend({}, properties),
          opts: jQuery.extend(true, {specialEasing: {}}, options),
          originalProperties: properties,
          originalOptions: options,
          startTime: fxNow || createFxNow(),
          duration: options.duration,
          tweens: [],
          createTween: function(prop, end) {
            var tween = jQuery.Tween(elem, animation.opts, prop, end, animation.opts.specialEasing[prop] || animation.opts.easing);
            animation.tweens.push(tween);
            return tween;
          },
          stop: function(gotoEnd) {
            var index = 0,
                length = gotoEnd ? animation.tweens.length : 0;
            if (stopped) {
              return this;
            }
            stopped = true;
            for (; index < length; index++) {
              animation.tweens[index].run(1);
            }
            if (gotoEnd) {
              deferred.resolveWith(elem, [animation, gotoEnd]);
            } else {
              deferred.rejectWith(elem, [animation, gotoEnd]);
            }
            return this;
          }
        }),
        props = animation.props;
    propFilter(props, animation.opts.specialEasing);
    for (; index < length; index++) {
      result = animationPrefilters[index].call(animation, elem, props, animation.opts);
      if (result) {
        return result;
      }
    }
    jQuery.map(props, createTween, animation);
    if (jQuery.isFunction(animation.opts.start)) {
      animation.opts.start.call(elem, animation);
    }
    jQuery.fx.timer(jQuery.extend(tick, {
      elem: elem,
      anim: animation,
      queue: animation.opts.queue
    }));
    return animation.progress(animation.opts.progress).done(animation.opts.done, animation.opts.complete).fail(animation.opts.fail).always(animation.opts.always);
  }
  jQuery.Animation = jQuery.extend(Animation, {
    tweener: function(props, callback) {
      if (jQuery.isFunction(props)) {
        callback = props;
        props = ["*"];
      } else {
        props = props.split(" ");
      }
      var prop,
          index = 0,
          length = props.length;
      for (; index < length; index++) {
        prop = props[index];
        tweeners[prop] = tweeners[prop] || [];
        tweeners[prop].unshift(callback);
      }
    },
    prefilter: function(callback, prepend) {
      if (prepend) {
        animationPrefilters.unshift(callback);
      } else {
        animationPrefilters.push(callback);
      }
    }
  });
  jQuery.speed = function(speed, easing, fn) {
    var opt = speed && typeof speed === "object" ? jQuery.extend({}, speed) : {
      complete: fn || !fn && easing || jQuery.isFunction(speed) && speed,
      duration: speed,
      easing: fn && easing || easing && !jQuery.isFunction(easing) && easing
    };
    opt.duration = jQuery.fx.off ? 0 : typeof opt.duration === "number" ? opt.duration : opt.duration in jQuery.fx.speeds ? jQuery.fx.speeds[opt.duration] : jQuery.fx.speeds._default;
    if (opt.queue == null || opt.queue === true) {
      opt.queue = "fx";
    }
    opt.old = opt.complete;
    opt.complete = function() {
      if (jQuery.isFunction(opt.old)) {
        opt.old.call(this);
      }
      if (opt.queue) {
        jQuery.dequeue(this, opt.queue);
      }
    };
    return opt;
  };
  jQuery.fn.extend({
    fadeTo: function(speed, to, easing, callback) {
      return this.filter(isHidden).css("opacity", 0).show().end().animate({opacity: to}, speed, easing, callback);
    },
    animate: function(prop, speed, easing, callback) {
      var empty = jQuery.isEmptyObject(prop),
          optall = jQuery.speed(speed, easing, callback),
          doAnimation = function() {
            var anim = Animation(this, jQuery.extend({}, prop), optall);
            if (empty || data_priv.get(this, "finish")) {
              anim.stop(true);
            }
          };
      doAnimation.finish = doAnimation;
      return empty || optall.queue === false ? this.each(doAnimation) : this.queue(optall.queue, doAnimation);
    },
    stop: function(type, clearQueue, gotoEnd) {
      var stopQueue = function(hooks) {
        var stop = hooks.stop;
        delete hooks.stop;
        stop(gotoEnd);
      };
      if (typeof type !== "string") {
        gotoEnd = clearQueue;
        clearQueue = type;
        type = undefined;
      }
      if (clearQueue && type !== false) {
        this.queue(type || "fx", []);
      }
      return this.each(function() {
        var dequeue = true,
            index = type != null && type + "queueHooks",
            timers = jQuery.timers,
            data = data_priv.get(this);
        if (index) {
          if (data[index] && data[index].stop) {
            stopQueue(data[index]);
          }
        } else {
          for (index in data) {
            if (data[index] && data[index].stop && rrun.test(index)) {
              stopQueue(data[index]);
            }
          }
        }
        for (index = timers.length; index--; ) {
          if (timers[index].elem === this && (type == null || timers[index].queue === type)) {
            timers[index].anim.stop(gotoEnd);
            dequeue = false;
            timers.splice(index, 1);
          }
        }
        if (dequeue || !gotoEnd) {
          jQuery.dequeue(this, type);
        }
      });
    },
    finish: function(type) {
      if (type !== false) {
        type = type || "fx";
      }
      return this.each(function() {
        var index,
            data = data_priv.get(this),
            queue = data[type + "queue"],
            hooks = data[type + "queueHooks"],
            timers = jQuery.timers,
            length = queue ? queue.length : 0;
        data.finish = true;
        jQuery.queue(this, type, []);
        if (hooks && hooks.stop) {
          hooks.stop.call(this, true);
        }
        for (index = timers.length; index--; ) {
          if (timers[index].elem === this && timers[index].queue === type) {
            timers[index].anim.stop(true);
            timers.splice(index, 1);
          }
        }
        for (index = 0; index < length; index++) {
          if (queue[index] && queue[index].finish) {
            queue[index].finish.call(this);
          }
        }
        delete data.finish;
      });
    }
  });
  jQuery.each(["toggle", "show", "hide"], function(i, name) {
    var cssFn = jQuery.fn[name];
    jQuery.fn[name] = function(speed, easing, callback) {
      return speed == null || typeof speed === "boolean" ? cssFn.apply(this, arguments) : this.animate(genFx(name, true), speed, easing, callback);
    };
  });
  jQuery.each({
    slideDown: genFx("show"),
    slideUp: genFx("hide"),
    slideToggle: genFx("toggle"),
    fadeIn: {opacity: "show"},
    fadeOut: {opacity: "hide"},
    fadeToggle: {opacity: "toggle"}
  }, function(name, props) {
    jQuery.fn[name] = function(speed, easing, callback) {
      return this.animate(props, speed, easing, callback);
    };
  });
  jQuery.timers = [];
  jQuery.fx.tick = function() {
    var timer,
        i = 0,
        timers = jQuery.timers;
    fxNow = jQuery.now();
    for (; i < timers.length; i++) {
      timer = timers[i];
      if (!timer() && timers[i] === timer) {
        timers.splice(i--, 1);
      }
    }
    if (!timers.length) {
      jQuery.fx.stop();
    }
    fxNow = undefined;
  };
  jQuery.fx.timer = function(timer) {
    jQuery.timers.push(timer);
    if (timer()) {
      jQuery.fx.start();
    } else {
      jQuery.timers.pop();
    }
  };
  jQuery.fx.interval = 13;
  jQuery.fx.start = function() {
    if (!timerId) {
      timerId = setInterval(jQuery.fx.tick, jQuery.fx.interval);
    }
  };
  jQuery.fx.stop = function() {
    clearInterval(timerId);
    timerId = null;
  };
  jQuery.fx.speeds = {
    slow: 600,
    fast: 200,
    _default: 400
  };
  jQuery.fn.delay = function(time, type) {
    time = jQuery.fx ? jQuery.fx.speeds[time] || time : time;
    type = type || "fx";
    return this.queue(type, function(next, hooks) {
      var timeout = setTimeout(next, time);
      hooks.stop = function() {
        clearTimeout(timeout);
      };
    });
  };
  (function() {
    var input = document.createElement("input"),
        select = document.createElement("select"),
        opt = select.appendChild(document.createElement("option"));
    input.type = "checkbox";
    support.checkOn = input.value !== "";
    support.optSelected = opt.selected;
    select.disabled = true;
    support.optDisabled = !opt.disabled;
    input = document.createElement("input");
    input.value = "t";
    input.type = "radio";
    support.radioValue = input.value === "t";
  })();
  var nodeHook,
      boolHook,
      attrHandle = jQuery.expr.attrHandle;
  jQuery.fn.extend({
    attr: function(name, value) {
      return access(this, jQuery.attr, name, value, arguments.length > 1);
    },
    removeAttr: function(name) {
      return this.each(function() {
        jQuery.removeAttr(this, name);
      });
    }
  });
  jQuery.extend({
    attr: function(elem, name, value) {
      var hooks,
          ret,
          nType = elem.nodeType;
      if (!elem || nType === 3 || nType === 8 || nType === 2) {
        return ;
      }
      if (typeof elem.getAttribute === strundefined) {
        return jQuery.prop(elem, name, value);
      }
      if (nType !== 1 || !jQuery.isXMLDoc(elem)) {
        name = name.toLowerCase();
        hooks = jQuery.attrHooks[name] || (jQuery.expr.match.bool.test(name) ? boolHook : nodeHook);
      }
      if (value !== undefined) {
        if (value === null) {
          jQuery.removeAttr(elem, name);
        } else if (hooks && "set" in hooks && (ret = hooks.set(elem, value, name)) !== undefined) {
          return ret;
        } else {
          elem.setAttribute(name, value + "");
          return value;
        }
      } else if (hooks && "get" in hooks && (ret = hooks.get(elem, name)) !== null) {
        return ret;
      } else {
        ret = jQuery.find.attr(elem, name);
        return ret == null ? undefined : ret;
      }
    },
    removeAttr: function(elem, value) {
      var name,
          propName,
          i = 0,
          attrNames = value && value.match(rnotwhite);
      if (attrNames && elem.nodeType === 1) {
        while ((name = attrNames[i++])) {
          propName = jQuery.propFix[name] || name;
          if (jQuery.expr.match.bool.test(name)) {
            elem[propName] = false;
          }
          elem.removeAttribute(name);
        }
      }
    },
    attrHooks: {type: {set: function(elem, value) {
          if (!support.radioValue && value === "radio" && jQuery.nodeName(elem, "input")) {
            var val = elem.value;
            elem.setAttribute("type", value);
            if (val) {
              elem.value = val;
            }
            return value;
          }
        }}}
  });
  boolHook = {set: function(elem, value, name) {
      if (value === false) {
        jQuery.removeAttr(elem, name);
      } else {
        elem.setAttribute(name, name);
      }
      return name;
    }};
  jQuery.each(jQuery.expr.match.bool.source.match(/\w+/g), function(i, name) {
    var getter = attrHandle[name] || jQuery.find.attr;
    attrHandle[name] = function(elem, name, isXML) {
      var ret,
          handle;
      if (!isXML) {
        handle = attrHandle[name];
        attrHandle[name] = ret;
        ret = getter(elem, name, isXML) != null ? name.toLowerCase() : null;
        attrHandle[name] = handle;
      }
      return ret;
    };
  });
  var rfocusable = /^(?:input|select|textarea|button)$/i;
  jQuery.fn.extend({
    prop: function(name, value) {
      return access(this, jQuery.prop, name, value, arguments.length > 1);
    },
    removeProp: function(name) {
      return this.each(function() {
        delete this[jQuery.propFix[name] || name];
      });
    }
  });
  jQuery.extend({
    propFix: {
      "for": "htmlFor",
      "class": "className"
    },
    prop: function(elem, name, value) {
      var ret,
          hooks,
          notxml,
          nType = elem.nodeType;
      if (!elem || nType === 3 || nType === 8 || nType === 2) {
        return ;
      }
      notxml = nType !== 1 || !jQuery.isXMLDoc(elem);
      if (notxml) {
        name = jQuery.propFix[name] || name;
        hooks = jQuery.propHooks[name];
      }
      if (value !== undefined) {
        return hooks && "set" in hooks && (ret = hooks.set(elem, value, name)) !== undefined ? ret : (elem[name] = value);
      } else {
        return hooks && "get" in hooks && (ret = hooks.get(elem, name)) !== null ? ret : elem[name];
      }
    },
    propHooks: {tabIndex: {get: function(elem) {
          return elem.hasAttribute("tabindex") || rfocusable.test(elem.nodeName) || elem.href ? elem.tabIndex : -1;
        }}}
  });
  if (!support.optSelected) {
    jQuery.propHooks.selected = {get: function(elem) {
        var parent = elem.parentNode;
        if (parent && parent.parentNode) {
          parent.parentNode.selectedIndex;
        }
        return null;
      }};
  }
  jQuery.each(["tabIndex", "readOnly", "maxLength", "cellSpacing", "cellPadding", "rowSpan", "colSpan", "useMap", "frameBorder", "contentEditable"], function() {
    jQuery.propFix[this.toLowerCase()] = this;
  });
  var rclass = /[\t\r\n\f]/g;
  jQuery.fn.extend({
    addClass: function(value) {
      var classes,
          elem,
          cur,
          clazz,
          j,
          finalValue,
          proceed = typeof value === "string" && value,
          i = 0,
          len = this.length;
      if (jQuery.isFunction(value)) {
        return this.each(function(j) {
          jQuery(this).addClass(value.call(this, j, this.className));
        });
      }
      if (proceed) {
        classes = (value || "").match(rnotwhite) || [];
        for (; i < len; i++) {
          elem = this[i];
          cur = elem.nodeType === 1 && (elem.className ? (" " + elem.className + " ").replace(rclass, " ") : " ");
          if (cur) {
            j = 0;
            while ((clazz = classes[j++])) {
              if (cur.indexOf(" " + clazz + " ") < 0) {
                cur += clazz + " ";
              }
            }
            finalValue = jQuery.trim(cur);
            if (elem.className !== finalValue) {
              elem.className = finalValue;
            }
          }
        }
      }
      return this;
    },
    removeClass: function(value) {
      var classes,
          elem,
          cur,
          clazz,
          j,
          finalValue,
          proceed = arguments.length === 0 || typeof value === "string" && value,
          i = 0,
          len = this.length;
      if (jQuery.isFunction(value)) {
        return this.each(function(j) {
          jQuery(this).removeClass(value.call(this, j, this.className));
        });
      }
      if (proceed) {
        classes = (value || "").match(rnotwhite) || [];
        for (; i < len; i++) {
          elem = this[i];
          cur = elem.nodeType === 1 && (elem.className ? (" " + elem.className + " ").replace(rclass, " ") : "");
          if (cur) {
            j = 0;
            while ((clazz = classes[j++])) {
              while (cur.indexOf(" " + clazz + " ") >= 0) {
                cur = cur.replace(" " + clazz + " ", " ");
              }
            }
            finalValue = value ? jQuery.trim(cur) : "";
            if (elem.className !== finalValue) {
              elem.className = finalValue;
            }
          }
        }
      }
      return this;
    },
    toggleClass: function(value, stateVal) {
      var type = typeof value;
      if (typeof stateVal === "boolean" && type === "string") {
        return stateVal ? this.addClass(value) : this.removeClass(value);
      }
      if (jQuery.isFunction(value)) {
        return this.each(function(i) {
          jQuery(this).toggleClass(value.call(this, i, this.className, stateVal), stateVal);
        });
      }
      return this.each(function() {
        if (type === "string") {
          var className,
              i = 0,
              self = jQuery(this),
              classNames = value.match(rnotwhite) || [];
          while ((className = classNames[i++])) {
            if (self.hasClass(className)) {
              self.removeClass(className);
            } else {
              self.addClass(className);
            }
          }
        } else if (type === strundefined || type === "boolean") {
          if (this.className) {
            data_priv.set(this, "__className__", this.className);
          }
          this.className = this.className || value === false ? "" : data_priv.get(this, "__className__") || "";
        }
      });
    },
    hasClass: function(selector) {
      var className = " " + selector + " ",
          i = 0,
          l = this.length;
      for (; i < l; i++) {
        if (this[i].nodeType === 1 && (" " + this[i].className + " ").replace(rclass, " ").indexOf(className) >= 0) {
          return true;
        }
      }
      return false;
    }
  });
  var rreturn = /\r/g;
  jQuery.fn.extend({val: function(value) {
      var hooks,
          ret,
          isFunction,
          elem = this[0];
      if (!arguments.length) {
        if (elem) {
          hooks = jQuery.valHooks[elem.type] || jQuery.valHooks[elem.nodeName.toLowerCase()];
          if (hooks && "get" in hooks && (ret = hooks.get(elem, "value")) !== undefined) {
            return ret;
          }
          ret = elem.value;
          return typeof ret === "string" ? ret.replace(rreturn, "") : ret == null ? "" : ret;
        }
        return ;
      }
      isFunction = jQuery.isFunction(value);
      return this.each(function(i) {
        var val;
        if (this.nodeType !== 1) {
          return ;
        }
        if (isFunction) {
          val = value.call(this, i, jQuery(this).val());
        } else {
          val = value;
        }
        if (val == null) {
          val = "";
        } else if (typeof val === "number") {
          val += "";
        } else if (jQuery.isArray(val)) {
          val = jQuery.map(val, function(value) {
            return value == null ? "" : value + "";
          });
        }
        hooks = jQuery.valHooks[this.type] || jQuery.valHooks[this.nodeName.toLowerCase()];
        if (!hooks || !("set" in hooks) || hooks.set(this, val, "value") === undefined) {
          this.value = val;
        }
      });
    }});
  jQuery.extend({valHooks: {
      option: {get: function(elem) {
          var val = jQuery.find.attr(elem, "value");
          return val != null ? val : jQuery.trim(jQuery.text(elem));
        }},
      select: {
        get: function(elem) {
          var value,
              option,
              options = elem.options,
              index = elem.selectedIndex,
              one = elem.type === "select-one" || index < 0,
              values = one ? null : [],
              max = one ? index + 1 : options.length,
              i = index < 0 ? max : one ? index : 0;
          for (; i < max; i++) {
            option = options[i];
            if ((option.selected || i === index) && (support.optDisabled ? !option.disabled : option.getAttribute("disabled") === null) && (!option.parentNode.disabled || !jQuery.nodeName(option.parentNode, "optgroup"))) {
              value = jQuery(option).val();
              if (one) {
                return value;
              }
              values.push(value);
            }
          }
          return values;
        },
        set: function(elem, value) {
          var optionSet,
              option,
              options = elem.options,
              values = jQuery.makeArray(value),
              i = options.length;
          while (i--) {
            option = options[i];
            if ((option.selected = jQuery.inArray(option.value, values) >= 0)) {
              optionSet = true;
            }
          }
          if (!optionSet) {
            elem.selectedIndex = -1;
          }
          return values;
        }
      }
    }});
  jQuery.each(["radio", "checkbox"], function() {
    jQuery.valHooks[this] = {set: function(elem, value) {
        if (jQuery.isArray(value)) {
          return (elem.checked = jQuery.inArray(jQuery(elem).val(), value) >= 0);
        }
      }};
    if (!support.checkOn) {
      jQuery.valHooks[this].get = function(elem) {
        return elem.getAttribute("value") === null ? "on" : elem.value;
      };
    }
  });
  jQuery.each(("blur focus focusin focusout load resize scroll unload click dblclick " + "mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave " + "change select submit keydown keypress keyup error contextmenu").split(" "), function(i, name) {
    jQuery.fn[name] = function(data, fn) {
      return arguments.length > 0 ? this.on(name, null, data, fn) : this.trigger(name);
    };
  });
  jQuery.fn.extend({
    hover: function(fnOver, fnOut) {
      return this.mouseenter(fnOver).mouseleave(fnOut || fnOver);
    },
    bind: function(types, data, fn) {
      return this.on(types, null, data, fn);
    },
    unbind: function(types, fn) {
      return this.off(types, null, fn);
    },
    delegate: function(selector, types, data, fn) {
      return this.on(types, selector, data, fn);
    },
    undelegate: function(selector, types, fn) {
      return arguments.length === 1 ? this.off(selector, "**") : this.off(types, selector || "**", fn);
    }
  });
  var nonce = jQuery.now();
  var rquery = (/\?/);
  jQuery.parseJSON = function(data) {
    return JSON.parse(data + "");
  };
  jQuery.parseXML = function(data) {
    var xml,
        tmp;
    if (!data || typeof data !== "string") {
      return null;
    }
    try {
      tmp = new DOMParser();
      xml = tmp.parseFromString(data, "text/xml");
    } catch (e) {
      xml = undefined;
    }
    if (!xml || xml.getElementsByTagName("parsererror").length) {
      jQuery.error("Invalid XML: " + data);
    }
    return xml;
  };
  var rhash = /#.*$/,
      rts = /([?&])_=[^&]*/,
      rheaders = /^(.*?):[ \t]*([^\r\n]*)$/mg,
      rlocalProtocol = /^(?:about|app|app-storage|.+-extension|file|res|widget):$/,
      rnoContent = /^(?:GET|HEAD)$/,
      rprotocol = /^\/\//,
      rurl = /^([\w.+-]+:)(?:\/\/(?:[^\/?#]*@|)([^\/?#:]*)(?::(\d+)|)|)/,
      prefilters = {},
      transports = {},
      allTypes = "*/".concat("*"),
      ajaxLocation = window.location.href,
      ajaxLocParts = rurl.exec(ajaxLocation.toLowerCase()) || [];
  function addToPrefiltersOrTransports(structure) {
    return function(dataTypeExpression, func) {
      if (typeof dataTypeExpression !== "string") {
        func = dataTypeExpression;
        dataTypeExpression = "*";
      }
      var dataType,
          i = 0,
          dataTypes = dataTypeExpression.toLowerCase().match(rnotwhite) || [];
      if (jQuery.isFunction(func)) {
        while ((dataType = dataTypes[i++])) {
          if (dataType[0] === "+") {
            dataType = dataType.slice(1) || "*";
            (structure[dataType] = structure[dataType] || []).unshift(func);
          } else {
            (structure[dataType] = structure[dataType] || []).push(func);
          }
        }
      }
    };
  }
  function inspectPrefiltersOrTransports(structure, options, originalOptions, jqXHR) {
    var inspected = {},
        seekingTransport = (structure === transports);
    function inspect(dataType) {
      var selected;
      inspected[dataType] = true;
      jQuery.each(structure[dataType] || [], function(_, prefilterOrFactory) {
        var dataTypeOrTransport = prefilterOrFactory(options, originalOptions, jqXHR);
        if (typeof dataTypeOrTransport === "string" && !seekingTransport && !inspected[dataTypeOrTransport]) {
          options.dataTypes.unshift(dataTypeOrTransport);
          inspect(dataTypeOrTransport);
          return false;
        } else if (seekingTransport) {
          return !(selected = dataTypeOrTransport);
        }
      });
      return selected;
    }
    return inspect(options.dataTypes[0]) || !inspected["*"] && inspect("*");
  }
  function ajaxExtend(target, src) {
    var key,
        deep,
        flatOptions = jQuery.ajaxSettings.flatOptions || {};
    for (key in src) {
      if (src[key] !== undefined) {
        (flatOptions[key] ? target : (deep || (deep = {})))[key] = src[key];
      }
    }
    if (deep) {
      jQuery.extend(true, target, deep);
    }
    return target;
  }
  function ajaxHandleResponses(s, jqXHR, responses) {
    var ct,
        type,
        finalDataType,
        firstDataType,
        contents = s.contents,
        dataTypes = s.dataTypes;
    while (dataTypes[0] === "*") {
      dataTypes.shift();
      if (ct === undefined) {
        ct = s.mimeType || jqXHR.getResponseHeader("Content-Type");
      }
    }
    if (ct) {
      for (type in contents) {
        if (contents[type] && contents[type].test(ct)) {
          dataTypes.unshift(type);
          break;
        }
      }
    }
    if (dataTypes[0] in responses) {
      finalDataType = dataTypes[0];
    } else {
      for (type in responses) {
        if (!dataTypes[0] || s.converters[type + " " + dataTypes[0]]) {
          finalDataType = type;
          break;
        }
        if (!firstDataType) {
          firstDataType = type;
        }
      }
      finalDataType = finalDataType || firstDataType;
    }
    if (finalDataType) {
      if (finalDataType !== dataTypes[0]) {
        dataTypes.unshift(finalDataType);
      }
      return responses[finalDataType];
    }
  }
  function ajaxConvert(s, response, jqXHR, isSuccess) {
    var conv2,
        current,
        conv,
        tmp,
        prev,
        converters = {},
        dataTypes = s.dataTypes.slice();
    if (dataTypes[1]) {
      for (conv in s.converters) {
        converters[conv.toLowerCase()] = s.converters[conv];
      }
    }
    current = dataTypes.shift();
    while (current) {
      if (s.responseFields[current]) {
        jqXHR[s.responseFields[current]] = response;
      }
      if (!prev && isSuccess && s.dataFilter) {
        response = s.dataFilter(response, s.dataType);
      }
      prev = current;
      current = dataTypes.shift();
      if (current) {
        if (current === "*") {
          current = prev;
        } else if (prev !== "*" && prev !== current) {
          conv = converters[prev + " " + current] || converters["* " + current];
          if (!conv) {
            for (conv2 in converters) {
              tmp = conv2.split(" ");
              if (tmp[1] === current) {
                conv = converters[prev + " " + tmp[0]] || converters["* " + tmp[0]];
                if (conv) {
                  if (conv === true) {
                    conv = converters[conv2];
                  } else if (converters[conv2] !== true) {
                    current = tmp[0];
                    dataTypes.unshift(tmp[1]);
                  }
                  break;
                }
              }
            }
          }
          if (conv !== true) {
            if (conv && s["throws"]) {
              response = conv(response);
            } else {
              try {
                response = conv(response);
              } catch (e) {
                return {
                  state: "parsererror",
                  error: conv ? e : "No conversion from " + prev + " to " + current
                };
              }
            }
          }
        }
      }
    }
    return {
      state: "success",
      data: response
    };
  }
  jQuery.extend({
    active: 0,
    lastModified: {},
    etag: {},
    ajaxSettings: {
      url: ajaxLocation,
      type: "GET",
      isLocal: rlocalProtocol.test(ajaxLocParts[1]),
      global: true,
      processData: true,
      async: true,
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      accepts: {
        "*": allTypes,
        text: "text/plain",
        html: "text/html",
        xml: "application/xml, text/xml",
        json: "application/json, text/javascript"
      },
      contents: {
        xml: /xml/,
        html: /html/,
        json: /json/
      },
      responseFields: {
        xml: "responseXML",
        text: "responseText",
        json: "responseJSON"
      },
      converters: {
        "* text": String,
        "text html": true,
        "text json": jQuery.parseJSON,
        "text xml": jQuery.parseXML
      },
      flatOptions: {
        url: true,
        context: true
      }
    },
    ajaxSetup: function(target, settings) {
      return settings ? ajaxExtend(ajaxExtend(target, jQuery.ajaxSettings), settings) : ajaxExtend(jQuery.ajaxSettings, target);
    },
    ajaxPrefilter: addToPrefiltersOrTransports(prefilters),
    ajaxTransport: addToPrefiltersOrTransports(transports),
    ajax: function(url, options) {
      if (typeof url === "object") {
        options = url;
        url = undefined;
      }
      options = options || {};
      var transport,
          cacheURL,
          responseHeadersString,
          responseHeaders,
          timeoutTimer,
          parts,
          fireGlobals,
          i,
          s = jQuery.ajaxSetup({}, options),
          callbackContext = s.context || s,
          globalEventContext = s.context && (callbackContext.nodeType || callbackContext.jquery) ? jQuery(callbackContext) : jQuery.event,
          deferred = jQuery.Deferred(),
          completeDeferred = jQuery.Callbacks("once memory"),
          statusCode = s.statusCode || {},
          requestHeaders = {},
          requestHeadersNames = {},
          state = 0,
          strAbort = "canceled",
          jqXHR = {
            readyState: 0,
            getResponseHeader: function(key) {
              var match;
              if (state === 2) {
                if (!responseHeaders) {
                  responseHeaders = {};
                  while ((match = rheaders.exec(responseHeadersString))) {
                    responseHeaders[match[1].toLowerCase()] = match[2];
                  }
                }
                match = responseHeaders[key.toLowerCase()];
              }
              return match == null ? null : match;
            },
            getAllResponseHeaders: function() {
              return state === 2 ? responseHeadersString : null;
            },
            setRequestHeader: function(name, value) {
              var lname = name.toLowerCase();
              if (!state) {
                name = requestHeadersNames[lname] = requestHeadersNames[lname] || name;
                requestHeaders[name] = value;
              }
              return this;
            },
            overrideMimeType: function(type) {
              if (!state) {
                s.mimeType = type;
              }
              return this;
            },
            statusCode: function(map) {
              var code;
              if (map) {
                if (state < 2) {
                  for (code in map) {
                    statusCode[code] = [statusCode[code], map[code]];
                  }
                } else {
                  jqXHR.always(map[jqXHR.status]);
                }
              }
              return this;
            },
            abort: function(statusText) {
              var finalText = statusText || strAbort;
              if (transport) {
                transport.abort(finalText);
              }
              done(0, finalText);
              return this;
            }
          };
      deferred.promise(jqXHR).complete = completeDeferred.add;
      jqXHR.success = jqXHR.done;
      jqXHR.error = jqXHR.fail;
      s.url = ((url || s.url || ajaxLocation) + "").replace(rhash, "").replace(rprotocol, ajaxLocParts[1] + "//");
      s.type = options.method || options.type || s.method || s.type;
      s.dataTypes = jQuery.trim(s.dataType || "*").toLowerCase().match(rnotwhite) || [""];
      if (s.crossDomain == null) {
        parts = rurl.exec(s.url.toLowerCase());
        s.crossDomain = !!(parts && (parts[1] !== ajaxLocParts[1] || parts[2] !== ajaxLocParts[2] || (parts[3] || (parts[1] === "http:" ? "80" : "443")) !== (ajaxLocParts[3] || (ajaxLocParts[1] === "http:" ? "80" : "443"))));
      }
      if (s.data && s.processData && typeof s.data !== "string") {
        s.data = jQuery.param(s.data, s.traditional);
      }
      inspectPrefiltersOrTransports(prefilters, s, options, jqXHR);
      if (state === 2) {
        return jqXHR;
      }
      fireGlobals = jQuery.event && s.global;
      if (fireGlobals && jQuery.active++ === 0) {
        jQuery.event.trigger("ajaxStart");
      }
      s.type = s.type.toUpperCase();
      s.hasContent = !rnoContent.test(s.type);
      cacheURL = s.url;
      if (!s.hasContent) {
        if (s.data) {
          cacheURL = (s.url += (rquery.test(cacheURL) ? "&" : "?") + s.data);
          delete s.data;
        }
        if (s.cache === false) {
          s.url = rts.test(cacheURL) ? cacheURL.replace(rts, "$1_=" + nonce++) : cacheURL + (rquery.test(cacheURL) ? "&" : "?") + "_=" + nonce++;
        }
      }
      if (s.ifModified) {
        if (jQuery.lastModified[cacheURL]) {
          jqXHR.setRequestHeader("If-Modified-Since", jQuery.lastModified[cacheURL]);
        }
        if (jQuery.etag[cacheURL]) {
          jqXHR.setRequestHeader("If-None-Match", jQuery.etag[cacheURL]);
        }
      }
      if (s.data && s.hasContent && s.contentType !== false || options.contentType) {
        jqXHR.setRequestHeader("Content-Type", s.contentType);
      }
      jqXHR.setRequestHeader("Accept", s.dataTypes[0] && s.accepts[s.dataTypes[0]] ? s.accepts[s.dataTypes[0]] + (s.dataTypes[0] !== "*" ? ", " + allTypes + "; q=0.01" : "") : s.accepts["*"]);
      for (i in s.headers) {
        jqXHR.setRequestHeader(i, s.headers[i]);
      }
      if (s.beforeSend && (s.beforeSend.call(callbackContext, jqXHR, s) === false || state === 2)) {
        return jqXHR.abort();
      }
      strAbort = "abort";
      for (i in {
        success: 1,
        error: 1,
        complete: 1
      }) {
        jqXHR[i](s[i]);
      }
      transport = inspectPrefiltersOrTransports(transports, s, options, jqXHR);
      if (!transport) {
        done(-1, "No Transport");
      } else {
        jqXHR.readyState = 1;
        if (fireGlobals) {
          globalEventContext.trigger("ajaxSend", [jqXHR, s]);
        }
        if (s.async && s.timeout > 0) {
          timeoutTimer = setTimeout(function() {
            jqXHR.abort("timeout");
          }, s.timeout);
        }
        try {
          state = 1;
          transport.send(requestHeaders, done);
        } catch (e) {
          if (state < 2) {
            done(-1, e);
          } else {
            throw e;
          }
        }
      }
      function done(status, nativeStatusText, responses, headers) {
        var isSuccess,
            success,
            error,
            response,
            modified,
            statusText = nativeStatusText;
        if (state === 2) {
          return ;
        }
        state = 2;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        transport = undefined;
        responseHeadersString = headers || "";
        jqXHR.readyState = status > 0 ? 4 : 0;
        isSuccess = status >= 200 && status < 300 || status === 304;
        if (responses) {
          response = ajaxHandleResponses(s, jqXHR, responses);
        }
        response = ajaxConvert(s, response, jqXHR, isSuccess);
        if (isSuccess) {
          if (s.ifModified) {
            modified = jqXHR.getResponseHeader("Last-Modified");
            if (modified) {
              jQuery.lastModified[cacheURL] = modified;
            }
            modified = jqXHR.getResponseHeader("etag");
            if (modified) {
              jQuery.etag[cacheURL] = modified;
            }
          }
          if (status === 204 || s.type === "HEAD") {
            statusText = "nocontent";
          } else if (status === 304) {
            statusText = "notmodified";
          } else {
            statusText = response.state;
            success = response.data;
            error = response.error;
            isSuccess = !error;
          }
        } else {
          error = statusText;
          if (status || !statusText) {
            statusText = "error";
            if (status < 0) {
              status = 0;
            }
          }
        }
        jqXHR.status = status;
        jqXHR.statusText = (nativeStatusText || statusText) + "";
        if (isSuccess) {
          deferred.resolveWith(callbackContext, [success, statusText, jqXHR]);
        } else {
          deferred.rejectWith(callbackContext, [jqXHR, statusText, error]);
        }
        jqXHR.statusCode(statusCode);
        statusCode = undefined;
        if (fireGlobals) {
          globalEventContext.trigger(isSuccess ? "ajaxSuccess" : "ajaxError", [jqXHR, s, isSuccess ? success : error]);
        }
        completeDeferred.fireWith(callbackContext, [jqXHR, statusText]);
        if (fireGlobals) {
          globalEventContext.trigger("ajaxComplete", [jqXHR, s]);
          if (!(--jQuery.active)) {
            jQuery.event.trigger("ajaxStop");
          }
        }
      }
      return jqXHR;
    },
    getJSON: function(url, data, callback) {
      return jQuery.get(url, data, callback, "json");
    },
    getScript: function(url, callback) {
      return jQuery.get(url, undefined, callback, "script");
    }
  });
  jQuery.each(["get", "post"], function(i, method) {
    jQuery[method] = function(url, data, callback, type) {
      if (jQuery.isFunction(data)) {
        type = type || callback;
        callback = data;
        data = undefined;
      }
      return jQuery.ajax({
        url: url,
        type: method,
        dataType: type,
        data: data,
        success: callback
      });
    };
  });
  jQuery._evalUrl = function(url) {
    return jQuery.ajax({
      url: url,
      type: "GET",
      dataType: "script",
      async: false,
      global: false,
      "throws": true
    });
  };
  jQuery.fn.extend({
    wrapAll: function(html) {
      var wrap;
      if (jQuery.isFunction(html)) {
        return this.each(function(i) {
          jQuery(this).wrapAll(html.call(this, i));
        });
      }
      if (this[0]) {
        wrap = jQuery(html, this[0].ownerDocument).eq(0).clone(true);
        if (this[0].parentNode) {
          wrap.insertBefore(this[0]);
        }
        wrap.map(function() {
          var elem = this;
          while (elem.firstElementChild) {
            elem = elem.firstElementChild;
          }
          return elem;
        }).append(this);
      }
      return this;
    },
    wrapInner: function(html) {
      if (jQuery.isFunction(html)) {
        return this.each(function(i) {
          jQuery(this).wrapInner(html.call(this, i));
        });
      }
      return this.each(function() {
        var self = jQuery(this),
            contents = self.contents();
        if (contents.length) {
          contents.wrapAll(html);
        } else {
          self.append(html);
        }
      });
    },
    wrap: function(html) {
      var isFunction = jQuery.isFunction(html);
      return this.each(function(i) {
        jQuery(this).wrapAll(isFunction ? html.call(this, i) : html);
      });
    },
    unwrap: function() {
      return this.parent().each(function() {
        if (!jQuery.nodeName(this, "body")) {
          jQuery(this).replaceWith(this.childNodes);
        }
      }).end();
    }
  });
  jQuery.expr.filters.hidden = function(elem) {
    return elem.offsetWidth <= 0 && elem.offsetHeight <= 0;
  };
  jQuery.expr.filters.visible = function(elem) {
    return !jQuery.expr.filters.hidden(elem);
  };
  var r20 = /%20/g,
      rbracket = /\[\]$/,
      rCRLF = /\r?\n/g,
      rsubmitterTypes = /^(?:submit|button|image|reset|file)$/i,
      rsubmittable = /^(?:input|select|textarea|keygen)/i;
  function buildParams(prefix, obj, traditional, add) {
    var name;
    if (jQuery.isArray(obj)) {
      jQuery.each(obj, function(i, v) {
        if (traditional || rbracket.test(prefix)) {
          add(prefix, v);
        } else {
          buildParams(prefix + "[" + (typeof v === "object" ? i : "") + "]", v, traditional, add);
        }
      });
    } else if (!traditional && jQuery.type(obj) === "object") {
      for (name in obj) {
        buildParams(prefix + "[" + name + "]", obj[name], traditional, add);
      }
    } else {
      add(prefix, obj);
    }
  }
  jQuery.param = function(a, traditional) {
    var prefix,
        s = [],
        add = function(key, value) {
          value = jQuery.isFunction(value) ? value() : (value == null ? "" : value);
          s[s.length] = encodeURIComponent(key) + "=" + encodeURIComponent(value);
        };
    if (traditional === undefined) {
      traditional = jQuery.ajaxSettings && jQuery.ajaxSettings.traditional;
    }
    if (jQuery.isArray(a) || (a.jquery && !jQuery.isPlainObject(a))) {
      jQuery.each(a, function() {
        add(this.name, this.value);
      });
    } else {
      for (prefix in a) {
        buildParams(prefix, a[prefix], traditional, add);
      }
    }
    return s.join("&").replace(r20, "+");
  };
  jQuery.fn.extend({
    serialize: function() {
      return jQuery.param(this.serializeArray());
    },
    serializeArray: function() {
      return this.map(function() {
        var elements = jQuery.prop(this, "elements");
        return elements ? jQuery.makeArray(elements) : this;
      }).filter(function() {
        var type = this.type;
        return this.name && !jQuery(this).is(":disabled") && rsubmittable.test(this.nodeName) && !rsubmitterTypes.test(type) && (this.checked || !rcheckableType.test(type));
      }).map(function(i, elem) {
        var val = jQuery(this).val();
        return val == null ? null : jQuery.isArray(val) ? jQuery.map(val, function(val) {
          return {
            name: elem.name,
            value: val.replace(rCRLF, "\r\n")
          };
        }) : {
          name: elem.name,
          value: val.replace(rCRLF, "\r\n")
        };
      }).get();
    }
  });
  jQuery.ajaxSettings.xhr = function() {
    try {
      return new XMLHttpRequest();
    } catch (e) {}
  };
  var xhrId = 0,
      xhrCallbacks = {},
      xhrSuccessStatus = {
        0: 200,
        1223: 204
      },
      xhrSupported = jQuery.ajaxSettings.xhr();
  if (window.attachEvent) {
    window.attachEvent("onunload", function() {
      for (var key in xhrCallbacks) {
        xhrCallbacks[key]();
      }
    });
  }
  support.cors = !!xhrSupported && ("withCredentials" in xhrSupported);
  support.ajax = xhrSupported = !!xhrSupported;
  jQuery.ajaxTransport(function(options) {
    var callback;
    if (support.cors || xhrSupported && !options.crossDomain) {
      return {
        send: function(headers, complete) {
          var i,
              xhr = options.xhr(),
              id = ++xhrId;
          xhr.open(options.type, options.url, options.async, options.username, options.password);
          if (options.xhrFields) {
            for (i in options.xhrFields) {
              xhr[i] = options.xhrFields[i];
            }
          }
          if (options.mimeType && xhr.overrideMimeType) {
            xhr.overrideMimeType(options.mimeType);
          }
          if (!options.crossDomain && !headers["X-Requested-With"]) {
            headers["X-Requested-With"] = "XMLHttpRequest";
          }
          for (i in headers) {
            xhr.setRequestHeader(i, headers[i]);
          }
          callback = function(type) {
            return function() {
              if (callback) {
                delete xhrCallbacks[id];
                callback = xhr.onload = xhr.onerror = null;
                if (type === "abort") {
                  xhr.abort();
                } else if (type === "error") {
                  complete(xhr.status, xhr.statusText);
                } else {
                  complete(xhrSuccessStatus[xhr.status] || xhr.status, xhr.statusText, typeof xhr.responseText === "string" ? {text: xhr.responseText} : undefined, xhr.getAllResponseHeaders());
                }
              }
            };
          };
          xhr.onload = callback();
          xhr.onerror = callback("error");
          callback = xhrCallbacks[id] = callback("abort");
          try {
            xhr.send(options.hasContent && options.data || null);
          } catch (e) {
            if (callback) {
              throw e;
            }
          }
        },
        abort: function() {
          if (callback) {
            callback();
          }
        }
      };
    }
  });
  jQuery.ajaxSetup({
    accepts: {script: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript"},
    contents: {script: /(?:java|ecma)script/},
    converters: {"text script": function(text) {
        jQuery.globalEval(text);
        return text;
      }}
  });
  jQuery.ajaxPrefilter("script", function(s) {
    if (s.cache === undefined) {
      s.cache = false;
    }
    if (s.crossDomain) {
      s.type = "GET";
    }
  });
  jQuery.ajaxTransport("script", function(s) {
    if (s.crossDomain) {
      var script,
          callback;
      return {
        send: function(_, complete) {
          script = jQuery("<script>").prop({
            async: true,
            charset: s.scriptCharset,
            src: s.url
          }).on("load error", callback = function(evt) {
            script.remove();
            callback = null;
            if (evt) {
              complete(evt.type === "error" ? 404 : 200, evt.type);
            }
          });
          document.head.appendChild(script[0]);
        },
        abort: function() {
          if (callback) {
            callback();
          }
        }
      };
    }
  });
  var oldCallbacks = [],
      rjsonp = /(=)\?(?=&|$)|\?\?/;
  jQuery.ajaxSetup({
    jsonp: "callback",
    jsonpCallback: function() {
      var callback = oldCallbacks.pop() || (jQuery.expando + "_" + (nonce++));
      this[callback] = true;
      return callback;
    }
  });
  jQuery.ajaxPrefilter("json jsonp", function(s, originalSettings, jqXHR) {
    var callbackName,
        overwritten,
        responseContainer,
        jsonProp = s.jsonp !== false && (rjsonp.test(s.url) ? "url" : typeof s.data === "string" && !(s.contentType || "").indexOf("application/x-www-form-urlencoded") && rjsonp.test(s.data) && "data");
    if (jsonProp || s.dataTypes[0] === "jsonp") {
      callbackName = s.jsonpCallback = jQuery.isFunction(s.jsonpCallback) ? s.jsonpCallback() : s.jsonpCallback;
      if (jsonProp) {
        s[jsonProp] = s[jsonProp].replace(rjsonp, "$1" + callbackName);
      } else if (s.jsonp !== false) {
        s.url += (rquery.test(s.url) ? "&" : "?") + s.jsonp + "=" + callbackName;
      }
      s.converters["script json"] = function() {
        if (!responseContainer) {
          jQuery.error(callbackName + " was not called");
        }
        return responseContainer[0];
      };
      s.dataTypes[0] = "json";
      overwritten = window[callbackName];
      window[callbackName] = function() {
        responseContainer = arguments;
      };
      jqXHR.always(function() {
        window[callbackName] = overwritten;
        if (s[callbackName]) {
          s.jsonpCallback = originalSettings.jsonpCallback;
          oldCallbacks.push(callbackName);
        }
        if (responseContainer && jQuery.isFunction(overwritten)) {
          overwritten(responseContainer[0]);
        }
        responseContainer = overwritten = undefined;
      });
      return "script";
    }
  });
  jQuery.parseHTML = function(data, context, keepScripts) {
    if (!data || typeof data !== "string") {
      return null;
    }
    if (typeof context === "boolean") {
      keepScripts = context;
      context = false;
    }
    context = context || document;
    var parsed = rsingleTag.exec(data),
        scripts = !keepScripts && [];
    if (parsed) {
      return [context.createElement(parsed[1])];
    }
    parsed = jQuery.buildFragment([data], context, scripts);
    if (scripts && scripts.length) {
      jQuery(scripts).remove();
    }
    return jQuery.merge([], parsed.childNodes);
  };
  var _load = jQuery.fn.load;
  jQuery.fn.load = function(url, params, callback) {
    if (typeof url !== "string" && _load) {
      return _load.apply(this, arguments);
    }
    var selector,
        type,
        response,
        self = this,
        off = url.indexOf(" ");
    if (off >= 0) {
      selector = jQuery.trim(url.slice(off));
      url = url.slice(0, off);
    }
    if (jQuery.isFunction(params)) {
      callback = params;
      params = undefined;
    } else if (params && typeof params === "object") {
      type = "POST";
    }
    if (self.length > 0) {
      jQuery.ajax({
        url: url,
        type: type,
        dataType: "html",
        data: params
      }).done(function(responseText) {
        response = arguments;
        self.html(selector ? jQuery("<div>").append(jQuery.parseHTML(responseText)).find(selector) : responseText);
      }).complete(callback && function(jqXHR, status) {
        self.each(callback, response || [jqXHR.responseText, status, jqXHR]);
      });
    }
    return this;
  };
  jQuery.each(["ajaxStart", "ajaxStop", "ajaxComplete", "ajaxError", "ajaxSuccess", "ajaxSend"], function(i, type) {
    jQuery.fn[type] = function(fn) {
      return this.on(type, fn);
    };
  });
  jQuery.expr.filters.animated = function(elem) {
    return jQuery.grep(jQuery.timers, function(fn) {
      return elem === fn.elem;
    }).length;
  };
  var docElem = window.document.documentElement;
  function getWindow(elem) {
    return jQuery.isWindow(elem) ? elem : elem.nodeType === 9 && elem.defaultView;
  }
  jQuery.offset = {setOffset: function(elem, options, i) {
      var curPosition,
          curLeft,
          curCSSTop,
          curTop,
          curOffset,
          curCSSLeft,
          calculatePosition,
          position = jQuery.css(elem, "position"),
          curElem = jQuery(elem),
          props = {};
      if (position === "static") {
        elem.style.position = "relative";
      }
      curOffset = curElem.offset();
      curCSSTop = jQuery.css(elem, "top");
      curCSSLeft = jQuery.css(elem, "left");
      calculatePosition = (position === "absolute" || position === "fixed") && (curCSSTop + curCSSLeft).indexOf("auto") > -1;
      if (calculatePosition) {
        curPosition = curElem.position();
        curTop = curPosition.top;
        curLeft = curPosition.left;
      } else {
        curTop = parseFloat(curCSSTop) || 0;
        curLeft = parseFloat(curCSSLeft) || 0;
      }
      if (jQuery.isFunction(options)) {
        options = options.call(elem, i, curOffset);
      }
      if (options.top != null) {
        props.top = (options.top - curOffset.top) + curTop;
      }
      if (options.left != null) {
        props.left = (options.left - curOffset.left) + curLeft;
      }
      if ("using" in options) {
        options.using.call(elem, props);
      } else {
        curElem.css(props);
      }
    }};
  jQuery.fn.extend({
    offset: function(options) {
      if (arguments.length) {
        return options === undefined ? this : this.each(function(i) {
          jQuery.offset.setOffset(this, options, i);
        });
      }
      var docElem,
          win,
          elem = this[0],
          box = {
            top: 0,
            left: 0
          },
          doc = elem && elem.ownerDocument;
      if (!doc) {
        return ;
      }
      docElem = doc.documentElement;
      if (!jQuery.contains(docElem, elem)) {
        return box;
      }
      if (typeof elem.getBoundingClientRect !== strundefined) {
        box = elem.getBoundingClientRect();
      }
      win = getWindow(doc);
      return {
        top: box.top + win.pageYOffset - docElem.clientTop,
        left: box.left + win.pageXOffset - docElem.clientLeft
      };
    },
    position: function() {
      if (!this[0]) {
        return ;
      }
      var offsetParent,
          offset,
          elem = this[0],
          parentOffset = {
            top: 0,
            left: 0
          };
      if (jQuery.css(elem, "position") === "fixed") {
        offset = elem.getBoundingClientRect();
      } else {
        offsetParent = this.offsetParent();
        offset = this.offset();
        if (!jQuery.nodeName(offsetParent[0], "html")) {
          parentOffset = offsetParent.offset();
        }
        parentOffset.top += jQuery.css(offsetParent[0], "borderTopWidth", true);
        parentOffset.left += jQuery.css(offsetParent[0], "borderLeftWidth", true);
      }
      return {
        top: offset.top - parentOffset.top - jQuery.css(elem, "marginTop", true),
        left: offset.left - parentOffset.left - jQuery.css(elem, "marginLeft", true)
      };
    },
    offsetParent: function() {
      return this.map(function() {
        var offsetParent = this.offsetParent || docElem;
        while (offsetParent && (!jQuery.nodeName(offsetParent, "html") && jQuery.css(offsetParent, "position") === "static")) {
          offsetParent = offsetParent.offsetParent;
        }
        return offsetParent || docElem;
      });
    }
  });
  jQuery.each({
    scrollLeft: "pageXOffset",
    scrollTop: "pageYOffset"
  }, function(method, prop) {
    var top = "pageYOffset" === prop;
    jQuery.fn[method] = function(val) {
      return access(this, function(elem, method, val) {
        var win = getWindow(elem);
        if (val === undefined) {
          return win ? win[prop] : elem[method];
        }
        if (win) {
          win.scrollTo(!top ? val : window.pageXOffset, top ? val : window.pageYOffset);
        } else {
          elem[method] = val;
        }
      }, method, val, arguments.length, null);
    };
  });
  jQuery.each(["top", "left"], function(i, prop) {
    jQuery.cssHooks[prop] = addGetHookIf(support.pixelPosition, function(elem, computed) {
      if (computed) {
        computed = curCSS(elem, prop);
        return rnumnonpx.test(computed) ? jQuery(elem).position()[prop] + "px" : computed;
      }
    });
  });
  jQuery.each({
    Height: "height",
    Width: "width"
  }, function(name, type) {
    jQuery.each({
      padding: "inner" + name,
      content: type,
      "": "outer" + name
    }, function(defaultExtra, funcName) {
      jQuery.fn[funcName] = function(margin, value) {
        var chainable = arguments.length && (defaultExtra || typeof margin !== "boolean"),
            extra = defaultExtra || (margin === true || value === true ? "margin" : "border");
        return access(this, function(elem, type, value) {
          var doc;
          if (jQuery.isWindow(elem)) {
            return elem.document.documentElement["client" + name];
          }
          if (elem.nodeType === 9) {
            doc = elem.documentElement;
            return Math.max(elem.body["scroll" + name], doc["scroll" + name], elem.body["offset" + name], doc["offset" + name], doc["client" + name]);
          }
          return value === undefined ? jQuery.css(elem, type, extra) : jQuery.style(elem, type, value, extra);
        }, type, chainable ? margin : undefined, chainable, null);
      };
    });
  });
  jQuery.fn.size = function() {
    return this.length;
  };
  jQuery.fn.andSelf = jQuery.fn.addBack;
  if (typeof define === "function" && define.amd) {
    System.register("github:components/jquery@2.1.3/jquery", [], false, function(__require, __exports, __module) {
      return (function() {
        return jQuery;
      }).call(this);
    });
  }
  var _jQuery = window.jQuery,
      _$ = window.$;
  jQuery.noConflict = function(deep) {
    if (window.$ === jQuery) {
      window.$ = _$;
    }
    if (deep && window.jQuery === jQuery) {
      window.jQuery = _jQuery;
    }
    return jQuery;
  };
  if (typeof noGlobal === strundefined) {
    window.jQuery = window.$ = jQuery;
  }
  return jQuery;
}));
})();
System.register("npm:core-js@0.9.6/library/fn/object/define-property", ["npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$");
  module.exports = function defineProperty(it, key, desc) {
    return $.setDesc(it, key, desc);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/helpers/class-call-check", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  exports["default"] = function(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/helpers/define-property", ["npm:babel-runtime@5.2.9/core-js/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = require("npm:babel-runtime@5.2.9/core-js/object/define-property")["default"];
  exports["default"] = function(obj, key, value) {
    return _Object$defineProperty(obj, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:base64-js@0.0.8/lib/b64", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  ;
  (function(exports) {
    'use strict';
    var Arr = (typeof Uint8Array !== 'undefined') ? Uint8Array : Array;
    var PLUS = '+'.charCodeAt(0);
    var SLASH = '/'.charCodeAt(0);
    var NUMBER = '0'.charCodeAt(0);
    var LOWER = 'a'.charCodeAt(0);
    var UPPER = 'A'.charCodeAt(0);
    var PLUS_URL_SAFE = '-'.charCodeAt(0);
    var SLASH_URL_SAFE = '_'.charCodeAt(0);
    function decode(elt) {
      var code = elt.charCodeAt(0);
      if (code === PLUS || code === PLUS_URL_SAFE)
        return 62;
      if (code === SLASH || code === SLASH_URL_SAFE)
        return 63;
      if (code < NUMBER)
        return -1;
      if (code < NUMBER + 10)
        return code - NUMBER + 26 + 26;
      if (code < UPPER + 26)
        return code - UPPER;
      if (code < LOWER + 26)
        return code - LOWER + 26;
    }
    function b64ToByteArray(b64) {
      var i,
          j,
          l,
          tmp,
          placeHolders,
          arr;
      if (b64.length % 4 > 0) {
        throw new Error('Invalid string. Length must be a multiple of 4');
      }
      var len = b64.length;
      placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0;
      arr = new Arr(b64.length * 3 / 4 - placeHolders);
      l = placeHolders > 0 ? b64.length - 4 : b64.length;
      var L = 0;
      function push(v) {
        arr[L++] = v;
      }
      for (i = 0, j = 0; i < l; i += 4, j += 3) {
        tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3));
        push((tmp & 0xFF0000) >> 16);
        push((tmp & 0xFF00) >> 8);
        push(tmp & 0xFF);
      }
      if (placeHolders === 2) {
        tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4);
        push(tmp & 0xFF);
      } else if (placeHolders === 1) {
        tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2);
        push((tmp >> 8) & 0xFF);
        push(tmp & 0xFF);
      }
      return arr;
    }
    function uint8ToBase64(uint8) {
      var i,
          extraBytes = uint8.length % 3,
          output = "",
          temp,
          length;
      function encode(num) {
        return lookup.charAt(num);
      }
      function tripletToBase64(num) {
        return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F);
      }
      for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
        temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2]);
        output += tripletToBase64(temp);
      }
      switch (extraBytes) {
        case 1:
          temp = uint8[uint8.length - 1];
          output += encode(temp >> 2);
          output += encode((temp << 4) & 0x3F);
          output += '==';
          break;
        case 2:
          temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1]);
          output += encode(temp >> 10);
          output += encode((temp >> 4) & 0x3F);
          output += encode((temp << 2) & 0x3F);
          output += '=';
          break;
      }
      return output;
    }
    exports.toByteArray = b64ToByteArray;
    exports.fromByteArray = uint8ToBase64;
  }(typeof exports === 'undefined' ? (this.base64js = {}) : exports));
  global.define = __define;
  return module.exports;
});

System.register("npm:ieee754@1.1.5/index", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  exports.read = function(buffer, offset, isLE, mLen, nBytes) {
    var e,
        m,
        eLen = nBytes * 8 - mLen - 1,
        eMax = (1 << eLen) - 1,
        eBias = eMax >> 1,
        nBits = -7,
        i = isLE ? (nBytes - 1) : 0,
        d = isLE ? -1 : 1,
        s = buffer[offset + i];
    i += d;
    e = s & ((1 << (-nBits)) - 1);
    s >>= (-nBits);
    nBits += eLen;
    for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}
    m = e & ((1 << (-nBits)) - 1);
    e >>= (-nBits);
    nBits += mLen;
    for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}
    if (e === 0) {
      e = 1 - eBias;
    } else if (e === eMax) {
      return m ? NaN : ((s ? -1 : 1) * Infinity);
    } else {
      m = m + Math.pow(2, mLen);
      e = e - eBias;
    }
    return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
  };
  exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
    var e,
        m,
        c,
        eLen = nBytes * 8 - mLen - 1,
        eMax = (1 << eLen) - 1,
        eBias = eMax >> 1,
        rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0),
        i = isLE ? 0 : (nBytes - 1),
        d = isLE ? 1 : -1,
        s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;
    value = Math.abs(value);
    if (isNaN(value) || value === Infinity) {
      m = isNaN(value) ? 1 : 0;
      e = eMax;
    } else {
      e = Math.floor(Math.log(value) / Math.LN2);
      if (value * (c = Math.pow(2, -e)) < 1) {
        e--;
        c *= 2;
      }
      if (e + eBias >= 1) {
        value += rt / c;
      } else {
        value += rt * Math.pow(2, 1 - eBias);
      }
      if (value * c >= 2) {
        e++;
        c /= 2;
      }
      if (e + eBias >= eMax) {
        m = 0;
        e = eMax;
      } else if (e + eBias >= 1) {
        m = (value * c - 1) * Math.pow(2, mLen);
        e = e + eBias;
      } else {
        m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
        e = 0;
      }
    }
    for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}
    e = (e << mLen) | m;
    eLen += mLen;
    for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}
    buffer[offset + i - d] |= s * 128;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:is-array@1.0.1/index", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var isArray = Array.isArray;
  var str = Object.prototype.toString;
  module.exports = isArray || function(val) {
    return !!val && '[object Array]' == str.call(val);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:inherits@2.0.1/inherits_browser", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  if (typeof Object.create === 'function') {
    module.exports = function inherits(ctor, superCtor) {
      ctor.super_ = superCtor;
      ctor.prototype = Object.create(superCtor.prototype, {constructor: {
          value: ctor,
          enumerable: false,
          writable: true,
          configurable: true
        }});
    };
  } else {
    module.exports = function inherits(ctor, superCtor) {
      ctor.super_ = superCtor;
      var TempCtor = function() {};
      TempCtor.prototype = superCtor.prototype;
      ctor.prototype = new TempCtor();
      ctor.prototype.constructor = ctor;
    };
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:create-hash@1.1.1/helpers", ["github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    'use strict';
    var intSize = 4;
    var zeroBuffer = new Buffer(intSize);
    zeroBuffer.fill(0);
    var chrsz = 8;
    function toArray(buf, bigEndian) {
      if ((buf.length % intSize) !== 0) {
        var len = buf.length + (intSize - (buf.length % intSize));
        buf = Buffer.concat([buf, zeroBuffer], len);
      }
      var arr = [];
      var fn = bigEndian ? buf.readInt32BE : buf.readInt32LE;
      for (var i = 0; i < buf.length; i += intSize) {
        arr.push(fn.call(buf, i));
      }
      return arr;
    }
    function toBuffer(arr, size, bigEndian) {
      var buf = new Buffer(size);
      var fn = bigEndian ? buf.writeInt32BE : buf.writeInt32LE;
      for (var i = 0; i < arr.length; i++) {
        fn.call(buf, arr[i], i * 4, true);
      }
      return buf;
    }
    function hash(buf, fn, hashSize, bigEndian) {
      if (!Buffer.isBuffer(buf))
        buf = new Buffer(buf);
      var arr = fn(toArray(buf, bigEndian), buf.length * chrsz);
      return toBuffer(arr, hashSize, bigEndian);
    }
    exports.hash = hash;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:ripemd160@1.0.0/lib/ripemd160", ["github:jspm/nodelibs-buffer@0.1.0", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer, process) {
    var zl = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13];
    var zr = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11];
    var sl = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6];
    var sr = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11];
    var hl = [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E];
    var hr = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000];
    function bytesToWords(bytes) {
      var words = [];
      for (var i = 0,
          b = 0; i < bytes.length; i++, b += 8) {
        words[b >>> 5] |= bytes[i] << (24 - b % 32);
      }
      return words;
    }
    function wordsToBytes(words) {
      var bytes = [];
      for (var b = 0; b < words.length * 32; b += 8) {
        bytes.push((words[b >>> 5] >>> (24 - b % 32)) & 0xFF);
      }
      return bytes;
    }
    function processBlock(H, M, offset) {
      for (var i = 0; i < 16; i++) {
        var offset_i = offset + i;
        var M_offset_i = M[offset_i];
        M[offset_i] = ((((M_offset_i << 8) | (M_offset_i >>> 24)) & 0x00ff00ff) | (((M_offset_i << 24) | (M_offset_i >>> 8)) & 0xff00ff00));
      }
      var al,
          bl,
          cl,
          dl,
          el;
      var ar,
          br,
          cr,
          dr,
          er;
      ar = al = H[0];
      br = bl = H[1];
      cr = cl = H[2];
      dr = dl = H[3];
      er = el = H[4];
      var t;
      for (var i = 0; i < 80; i += 1) {
        t = (al + M[offset + zl[i]]) | 0;
        if (i < 16) {
          t += f1(bl, cl, dl) + hl[0];
        } else if (i < 32) {
          t += f2(bl, cl, dl) + hl[1];
        } else if (i < 48) {
          t += f3(bl, cl, dl) + hl[2];
        } else if (i < 64) {
          t += f4(bl, cl, dl) + hl[3];
        } else {
          t += f5(bl, cl, dl) + hl[4];
        }
        t = t | 0;
        t = rotl(t, sl[i]);
        t = (t + el) | 0;
        al = el;
        el = dl;
        dl = rotl(cl, 10);
        cl = bl;
        bl = t;
        t = (ar + M[offset + zr[i]]) | 0;
        if (i < 16) {
          t += f5(br, cr, dr) + hr[0];
        } else if (i < 32) {
          t += f4(br, cr, dr) + hr[1];
        } else if (i < 48) {
          t += f3(br, cr, dr) + hr[2];
        } else if (i < 64) {
          t += f2(br, cr, dr) + hr[3];
        } else {
          t += f1(br, cr, dr) + hr[4];
        }
        t = t | 0;
        t = rotl(t, sr[i]);
        t = (t + er) | 0;
        ar = er;
        er = dr;
        dr = rotl(cr, 10);
        cr = br;
        br = t;
      }
      t = (H[1] + cl + dr) | 0;
      H[1] = (H[2] + dl + er) | 0;
      H[2] = (H[3] + el + ar) | 0;
      H[3] = (H[4] + al + br) | 0;
      H[4] = (H[0] + bl + cr) | 0;
      H[0] = t;
    }
    function f1(x, y, z) {
      return ((x) ^ (y) ^ (z));
    }
    function f2(x, y, z) {
      return (((x) & (y)) | ((~x) & (z)));
    }
    function f3(x, y, z) {
      return (((x) | (~(y))) ^ (z));
    }
    function f4(x, y, z) {
      return (((x) & (z)) | ((y) & (~(z))));
    }
    function f5(x, y, z) {
      return ((x) ^ ((y) | (~(z))));
    }
    function rotl(x, n) {
      return (x << n) | (x >>> (32 - n));
    }
    function ripemd160(message) {
      var H = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
      if (typeof message == 'string')
        message = new Buffer(message, 'utf8');
      var m = bytesToWords(message);
      var nBitsLeft = message.length * 8;
      var nBitsTotal = message.length * 8;
      m[nBitsLeft >>> 5] |= 0x80 << (24 - nBitsLeft % 32);
      m[(((nBitsLeft + 64) >>> 9) << 4) + 14] = ((((nBitsTotal << 8) | (nBitsTotal >>> 24)) & 0x00ff00ff) | (((nBitsTotal << 24) | (nBitsTotal >>> 8)) & 0xff00ff00));
      for (var i = 0; i < m.length; i += 16) {
        processBlock(H, m, i);
      }
      for (var i = 0; i < 5; i++) {
        var H_i = H[i];
        H[i] = (((H_i << 8) | (H_i >>> 24)) & 0x00ff00ff) | (((H_i << 24) | (H_i >>> 8)) & 0xff00ff00);
      }
      var digestbytes = wordsToBytes(H);
      return new Buffer(digestbytes);
    }
    module.exports = ripemd160;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer, require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:sha.js@2.4.0/hash", ["github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    function Hash(blockSize, finalSize) {
      this._block = new Buffer(blockSize);
      this._finalSize = finalSize;
      this._blockSize = blockSize;
      this._len = 0;
      this._s = 0;
    }
    Hash.prototype.update = function(data, enc) {
      if ("string" === typeof data) {
        enc = enc || "utf8";
        data = new Buffer(data, enc);
      }
      var l = this._len += data.length;
      var s = this._s || 0;
      var f = 0;
      var buffer = this._block;
      while (s < l) {
        var t = Math.min(data.length, f + this._blockSize - (s % this._blockSize));
        var ch = (t - f);
        for (var i = 0; i < ch; i++) {
          buffer[(s % this._blockSize) + i] = data[i + f];
        }
        s += ch;
        f += ch;
        if ((s % this._blockSize) === 0) {
          this._update(buffer);
        }
      }
      this._s = s;
      return this;
    };
    Hash.prototype.digest = function(enc) {
      var l = this._len * 8;
      this._block[this._len % this._blockSize] = 0x80;
      this._block.fill(0, this._len % this._blockSize + 1);
      if (l % (this._blockSize * 8) >= this._finalSize * 8) {
        this._update(this._block);
        this._block.fill(0);
      }
      this._block.writeInt32BE(l, this._blockSize - 4);
      var hash = this._update(this._block) || this._hash();
      return enc ? hash.toString(enc) : hash;
    };
    Hash.prototype._update = function() {
      throw new Error('_update must be implemented by subclass');
    };
    module.exports = Hash;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:sha.js@2.4.0/sha1", ["npm:inherits@2.0.1", "npm:sha.js@2.4.0/hash", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var inherits = require("npm:inherits@2.0.1");
    var Hash = require("npm:sha.js@2.4.0/hash");
    var W = new Array(80);
    function Sha1() {
      this.init();
      this._w = W;
      Hash.call(this, 64, 56);
    }
    inherits(Sha1, Hash);
    Sha1.prototype.init = function() {
      this._a = 0x67452301;
      this._b = 0xefcdab89;
      this._c = 0x98badcfe;
      this._d = 0x10325476;
      this._e = 0xc3d2e1f0;
      return this;
    };
    function rol(num, cnt) {
      return (num << cnt) | (num >>> (32 - cnt));
    }
    Sha1.prototype._update = function(M) {
      var W = this._w;
      var a = this._a;
      var b = this._b;
      var c = this._c;
      var d = this._d;
      var e = this._e;
      var j = 0,
          k;
      function calcW() {
        return rol(W[j - 3] ^ W[j - 8] ^ W[j - 14] ^ W[j - 16], 1);
      }
      function loop(w, f) {
        W[j] = w;
        var t = rol(a, 5) + f + e + w + k;
        e = d;
        d = c;
        c = rol(b, 30);
        b = a;
        a = t;
        j++;
      }
      k = 1518500249;
      while (j < 16)
        loop(M.readInt32BE(j * 4), (b & c) | ((~b) & d));
      while (j < 20)
        loop(calcW(), (b & c) | ((~b) & d));
      k = 1859775393;
      while (j < 40)
        loop(calcW(), b ^ c ^ d);
      k = -1894007588;
      while (j < 60)
        loop(calcW(), (b & c) | (b & d) | (c & d));
      k = -899497514;
      while (j < 80)
        loop(calcW(), b ^ c ^ d);
      this._a = (a + this._a) | 0;
      this._b = (b + this._b) | 0;
      this._c = (c + this._c) | 0;
      this._d = (d + this._d) | 0;
      this._e = (e + this._e) | 0;
    };
    Sha1.prototype._hash = function() {
      var H = new Buffer(20);
      H.writeInt32BE(this._a | 0, 0);
      H.writeInt32BE(this._b | 0, 4);
      H.writeInt32BE(this._c | 0, 8);
      H.writeInt32BE(this._d | 0, 12);
      H.writeInt32BE(this._e | 0, 16);
      return H;
    };
    module.exports = Sha1;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:sha.js@2.4.0/sha256", ["npm:inherits@2.0.1", "npm:sha.js@2.4.0/hash", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var inherits = require("npm:inherits@2.0.1");
    var Hash = require("npm:sha.js@2.4.0/hash");
    var K = [0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174, 0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA, 0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967, 0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070, 0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2];
    var W = new Array(64);
    function Sha256() {
      this.init();
      this._w = W;
      Hash.call(this, 64, 56);
    }
    inherits(Sha256, Hash);
    Sha256.prototype.init = function() {
      this._a = 0x6a09e667 | 0;
      this._b = 0xbb67ae85 | 0;
      this._c = 0x3c6ef372 | 0;
      this._d = 0xa54ff53a | 0;
      this._e = 0x510e527f | 0;
      this._f = 0x9b05688c | 0;
      this._g = 0x1f83d9ab | 0;
      this._h = 0x5be0cd19 | 0;
      return this;
    };
    function S(X, n) {
      return (X >>> n) | (X << (32 - n));
    }
    function R(X, n) {
      return (X >>> n);
    }
    function Ch(x, y, z) {
      return ((x & y) ^ ((~x) & z));
    }
    function Maj(x, y, z) {
      return ((x & y) ^ (x & z) ^ (y & z));
    }
    function Sigma0256(x) {
      return (S(x, 2) ^ S(x, 13) ^ S(x, 22));
    }
    function Sigma1256(x) {
      return (S(x, 6) ^ S(x, 11) ^ S(x, 25));
    }
    function Gamma0256(x) {
      return (S(x, 7) ^ S(x, 18) ^ R(x, 3));
    }
    function Gamma1256(x) {
      return (S(x, 17) ^ S(x, 19) ^ R(x, 10));
    }
    Sha256.prototype._update = function(M) {
      var W = this._w;
      var a = this._a | 0;
      var b = this._b | 0;
      var c = this._c | 0;
      var d = this._d | 0;
      var e = this._e | 0;
      var f = this._f | 0;
      var g = this._g | 0;
      var h = this._h | 0;
      var j = 0;
      function calcW() {
        return Gamma1256(W[j - 2]) + W[j - 7] + Gamma0256(W[j - 15]) + W[j - 16];
      }
      function loop(w) {
        W[j] = w;
        var T1 = h + Sigma1256(e) + Ch(e, f, g) + K[j] + w;
        var T2 = Sigma0256(a) + Maj(a, b, c);
        h = g;
        g = f;
        f = e;
        e = d + T1;
        d = c;
        c = b;
        b = a;
        a = T1 + T2;
        j++;
      }
      while (j < 16)
        loop(M.readInt32BE(j * 4));
      while (j < 64)
        loop(calcW());
      this._a = (a + this._a) | 0;
      this._b = (b + this._b) | 0;
      this._c = (c + this._c) | 0;
      this._d = (d + this._d) | 0;
      this._e = (e + this._e) | 0;
      this._f = (f + this._f) | 0;
      this._g = (g + this._g) | 0;
      this._h = (h + this._h) | 0;
    };
    Sha256.prototype._hash = function() {
      var H = new Buffer(32);
      H.writeInt32BE(this._a, 0);
      H.writeInt32BE(this._b, 4);
      H.writeInt32BE(this._c, 8);
      H.writeInt32BE(this._d, 12);
      H.writeInt32BE(this._e, 16);
      H.writeInt32BE(this._f, 20);
      H.writeInt32BE(this._g, 24);
      H.writeInt32BE(this._h, 28);
      return H;
    };
    module.exports = Sha256;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:sha.js@2.4.0/sha512", ["npm:inherits@2.0.1", "npm:sha.js@2.4.0/hash", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var inherits = require("npm:inherits@2.0.1");
    var Hash = require("npm:sha.js@2.4.0/hash");
    var K = [0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65, 0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b, 0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3, 0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec, 0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817];
    var W = new Array(160);
    function Sha512() {
      this.init();
      this._w = W;
      Hash.call(this, 128, 112);
    }
    inherits(Sha512, Hash);
    Sha512.prototype.init = function() {
      this._a = 0x6a09e667 | 0;
      this._b = 0xbb67ae85 | 0;
      this._c = 0x3c6ef372 | 0;
      this._d = 0xa54ff53a | 0;
      this._e = 0x510e527f | 0;
      this._f = 0x9b05688c | 0;
      this._g = 0x1f83d9ab | 0;
      this._h = 0x5be0cd19 | 0;
      this._al = 0xf3bcc908 | 0;
      this._bl = 0x84caa73b | 0;
      this._cl = 0xfe94f82b | 0;
      this._dl = 0x5f1d36f1 | 0;
      this._el = 0xade682d1 | 0;
      this._fl = 0x2b3e6c1f | 0;
      this._gl = 0xfb41bd6b | 0;
      this._hl = 0x137e2179 | 0;
      return this;
    };
    function S(X, Xl, n) {
      return (X >>> n) | (Xl << (32 - n));
    }
    function Ch(x, y, z) {
      return ((x & y) ^ ((~x) & z));
    }
    function Maj(x, y, z) {
      return ((x & y) ^ (x & z) ^ (y & z));
    }
    Sha512.prototype._update = function(M) {
      var W = this._w;
      var a = this._a | 0;
      var b = this._b | 0;
      var c = this._c | 0;
      var d = this._d | 0;
      var e = this._e | 0;
      var f = this._f | 0;
      var g = this._g | 0;
      var h = this._h | 0;
      var al = this._al | 0;
      var bl = this._bl | 0;
      var cl = this._cl | 0;
      var dl = this._dl | 0;
      var el = this._el | 0;
      var fl = this._fl | 0;
      var gl = this._gl | 0;
      var hl = this._hl | 0;
      var i = 0,
          j = 0;
      var Wi,
          Wil;
      function calcW() {
        var x = W[j - 15 * 2];
        var xl = W[j - 15 * 2 + 1];
        var gamma0 = S(x, xl, 1) ^ S(x, xl, 8) ^ (x >>> 7);
        var gamma0l = S(xl, x, 1) ^ S(xl, x, 8) ^ S(xl, x, 7);
        x = W[j - 2 * 2];
        xl = W[j - 2 * 2 + 1];
        var gamma1 = S(x, xl, 19) ^ S(xl, x, 29) ^ (x >>> 6);
        var gamma1l = S(xl, x, 19) ^ S(x, xl, 29) ^ S(xl, x, 6);
        var Wi7 = W[j - 7 * 2];
        var Wi7l = W[j - 7 * 2 + 1];
        var Wi16 = W[j - 16 * 2];
        var Wi16l = W[j - 16 * 2 + 1];
        Wil = gamma0l + Wi7l;
        Wi = gamma0 + Wi7 + ((Wil >>> 0) < (gamma0l >>> 0) ? 1 : 0);
        Wil = Wil + gamma1l;
        Wi = Wi + gamma1 + ((Wil >>> 0) < (gamma1l >>> 0) ? 1 : 0);
        Wil = Wil + Wi16l;
        Wi = Wi + Wi16 + ((Wil >>> 0) < (Wi16l >>> 0) ? 1 : 0);
      }
      function loop() {
        W[j] = Wi;
        W[j + 1] = Wil;
        var maj = Maj(a, b, c);
        var majl = Maj(al, bl, cl);
        var sigma0h = S(a, al, 28) ^ S(al, a, 2) ^ S(al, a, 7);
        var sigma0l = S(al, a, 28) ^ S(a, al, 2) ^ S(a, al, 7);
        var sigma1h = S(e, el, 14) ^ S(e, el, 18) ^ S(el, e, 9);
        var sigma1l = S(el, e, 14) ^ S(el, e, 18) ^ S(e, el, 9);
        var Ki = K[j];
        var Kil = K[j + 1];
        var ch = Ch(e, f, g);
        var chl = Ch(el, fl, gl);
        var t1l = hl + sigma1l;
        var t1 = h + sigma1h + ((t1l >>> 0) < (hl >>> 0) ? 1 : 0);
        t1l = t1l + chl;
        t1 = t1 + ch + ((t1l >>> 0) < (chl >>> 0) ? 1 : 0);
        t1l = t1l + Kil;
        t1 = t1 + Ki + ((t1l >>> 0) < (Kil >>> 0) ? 1 : 0);
        t1l = t1l + Wil;
        t1 = t1 + Wi + ((t1l >>> 0) < (Wil >>> 0) ? 1 : 0);
        var t2l = sigma0l + majl;
        var t2 = sigma0h + maj + ((t2l >>> 0) < (sigma0l >>> 0) ? 1 : 0);
        h = g;
        hl = gl;
        g = f;
        gl = fl;
        f = e;
        fl = el;
        el = (dl + t1l) | 0;
        e = (d + t1 + ((el >>> 0) < (dl >>> 0) ? 1 : 0)) | 0;
        d = c;
        dl = cl;
        c = b;
        cl = bl;
        b = a;
        bl = al;
        al = (t1l + t2l) | 0;
        a = (t1 + t2 + ((al >>> 0) < (t1l >>> 0) ? 1 : 0)) | 0;
        i++;
        j += 2;
      }
      while (i < 16) {
        Wi = M.readInt32BE(j * 4);
        Wil = M.readInt32BE(j * 4 + 4);
        loop();
      }
      while (i < 80) {
        calcW();
        loop();
      }
      this._al = (this._al + al) | 0;
      this._bl = (this._bl + bl) | 0;
      this._cl = (this._cl + cl) | 0;
      this._dl = (this._dl + dl) | 0;
      this._el = (this._el + el) | 0;
      this._fl = (this._fl + fl) | 0;
      this._gl = (this._gl + gl) | 0;
      this._hl = (this._hl + hl) | 0;
      this._a = (this._a + a + ((this._al >>> 0) < (al >>> 0) ? 1 : 0)) | 0;
      this._b = (this._b + b + ((this._bl >>> 0) < (bl >>> 0) ? 1 : 0)) | 0;
      this._c = (this._c + c + ((this._cl >>> 0) < (cl >>> 0) ? 1 : 0)) | 0;
      this._d = (this._d + d + ((this._dl >>> 0) < (dl >>> 0) ? 1 : 0)) | 0;
      this._e = (this._e + e + ((this._el >>> 0) < (el >>> 0) ? 1 : 0)) | 0;
      this._f = (this._f + f + ((this._fl >>> 0) < (fl >>> 0) ? 1 : 0)) | 0;
      this._g = (this._g + g + ((this._gl >>> 0) < (gl >>> 0) ? 1 : 0)) | 0;
      this._h = (this._h + h + ((this._hl >>> 0) < (hl >>> 0) ? 1 : 0)) | 0;
    };
    Sha512.prototype._hash = function() {
      var H = new Buffer(64);
      function writeInt64BE(h, l, offset) {
        H.writeInt32BE(h, offset);
        H.writeInt32BE(l, offset + 4);
      }
      writeInt64BE(this._a, this._al, 0);
      writeInt64BE(this._b, this._bl, 8);
      writeInt64BE(this._c, this._cl, 16);
      writeInt64BE(this._d, this._dl, 24);
      writeInt64BE(this._e, this._el, 32);
      writeInt64BE(this._f, this._fl, 40);
      writeInt64BE(this._g, this._gl, 48);
      writeInt64BE(this._h, this._hl, 56);
      return H;
    };
    module.exports = Sha512;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:events-browserify@0.0.1/events", ["github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    if (!process.EventEmitter)
      process.EventEmitter = function() {};
    var EventEmitter = exports.EventEmitter = process.EventEmitter;
    var isArray = typeof Array.isArray === 'function' ? Array.isArray : function(xs) {
      return Object.prototype.toString.call(xs) === '[object Array]';
    };
    ;
    var defaultMaxListeners = 10;
    EventEmitter.prototype.setMaxListeners = function(n) {
      if (!this._events)
        this._events = {};
      this._events.maxListeners = n;
    };
    EventEmitter.prototype.emit = function(type) {
      if (type === 'error') {
        if (!this._events || !this._events.error || (isArray(this._events.error) && !this._events.error.length)) {
          if (arguments[1] instanceof Error) {
            throw arguments[1];
          } else {
            throw new Error("Uncaught, unspecified 'error' event.");
          }
          return false;
        }
      }
      if (!this._events)
        return false;
      var handler = this._events[type];
      if (!handler)
        return false;
      if (typeof handler == 'function') {
        switch (arguments.length) {
          case 1:
            handler.call(this);
            break;
          case 2:
            handler.call(this, arguments[1]);
            break;
          case 3:
            handler.call(this, arguments[1], arguments[2]);
            break;
          default:
            var args = Array.prototype.slice.call(arguments, 1);
            handler.apply(this, args);
        }
        return true;
      } else if (isArray(handler)) {
        var args = Array.prototype.slice.call(arguments, 1);
        var listeners = handler.slice();
        for (var i = 0,
            l = listeners.length; i < l; i++) {
          listeners[i].apply(this, args);
        }
        return true;
      } else {
        return false;
      }
    };
    EventEmitter.prototype.addListener = function(type, listener) {
      if ('function' !== typeof listener) {
        throw new Error('addListener only takes instances of Function');
      }
      if (!this._events)
        this._events = {};
      this.emit('newListener', type, listener);
      if (!this._events[type]) {
        this._events[type] = listener;
      } else if (isArray(this._events[type])) {
        if (!this._events[type].warned) {
          var m;
          if (this._events.maxListeners !== undefined) {
            m = this._events.maxListeners;
          } else {
            m = defaultMaxListeners;
          }
          if (m && m > 0 && this._events[type].length > m) {
            this._events[type].warned = true;
            console.error('(node) warning: possible EventEmitter memory ' + 'leak detected. %d listeners added. ' + 'Use emitter.setMaxListeners() to increase limit.', this._events[type].length);
            console.trace();
          }
        }
        this._events[type].push(listener);
      } else {
        this._events[type] = [this._events[type], listener];
      }
      return this;
    };
    EventEmitter.prototype.on = EventEmitter.prototype.addListener;
    EventEmitter.prototype.once = function(type, listener) {
      var self = this;
      self.on(type, function g() {
        self.removeListener(type, g);
        listener.apply(this, arguments);
      });
      return this;
    };
    EventEmitter.prototype.removeListener = function(type, listener) {
      if ('function' !== typeof listener) {
        throw new Error('removeListener only takes instances of Function');
      }
      if (!this._events || !this._events[type])
        return this;
      var list = this._events[type];
      if (isArray(list)) {
        var i = list.indexOf(listener);
        if (i < 0)
          return this;
        list.splice(i, 1);
        if (list.length == 0)
          delete this._events[type];
      } else if (this._events[type] === listener) {
        delete this._events[type];
      }
      return this;
    };
    EventEmitter.prototype.removeAllListeners = function(type) {
      if (type && this._events && this._events[type])
        this._events[type] = null;
      return this;
    };
    EventEmitter.prototype.listeners = function(type) {
      if (!this._events)
        this._events = {};
      if (!this._events[type])
        this._events[type] = [];
      if (!isArray(this._events[type])) {
        this._events[type] = [this._events[type]];
      }
      return this._events[type];
    };
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:isarray@0.0.1/index", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = Array.isArray || function(arr) {
    return Object.prototype.toString.call(arr) == '[object Array]';
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-util-is@1.0.1/lib/util", ["github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    function isArray(ar) {
      return Array.isArray(ar);
    }
    exports.isArray = isArray;
    function isBoolean(arg) {
      return typeof arg === 'boolean';
    }
    exports.isBoolean = isBoolean;
    function isNull(arg) {
      return arg === null;
    }
    exports.isNull = isNull;
    function isNullOrUndefined(arg) {
      return arg == null;
    }
    exports.isNullOrUndefined = isNullOrUndefined;
    function isNumber(arg) {
      return typeof arg === 'number';
    }
    exports.isNumber = isNumber;
    function isString(arg) {
      return typeof arg === 'string';
    }
    exports.isString = isString;
    function isSymbol(arg) {
      return typeof arg === 'symbol';
    }
    exports.isSymbol = isSymbol;
    function isUndefined(arg) {
      return arg === void 0;
    }
    exports.isUndefined = isUndefined;
    function isRegExp(re) {
      return isObject(re) && objectToString(re) === '[object RegExp]';
    }
    exports.isRegExp = isRegExp;
    function isObject(arg) {
      return typeof arg === 'object' && arg !== null;
    }
    exports.isObject = isObject;
    function isDate(d) {
      return isObject(d) && objectToString(d) === '[object Date]';
    }
    exports.isDate = isDate;
    function isError(e) {
      return isObject(e) && (objectToString(e) === '[object Error]' || e instanceof Error);
    }
    exports.isError = isError;
    function isFunction(arg) {
      return typeof arg === 'function';
    }
    exports.isFunction = isFunction;
    function isPrimitive(arg) {
      return arg === null || typeof arg === 'boolean' || typeof arg === 'number' || typeof arg === 'string' || typeof arg === 'symbol' || typeof arg === 'undefined';
    }
    exports.isPrimitive = isPrimitive;
    function isBuffer(arg) {
      return Buffer.isBuffer(arg);
    }
    exports.isBuffer = isBuffer;
    function objectToString(o) {
      return Object.prototype.toString.call(o);
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:readable-stream@1.1.13/lib/_stream_writable", ["github:jspm/nodelibs-buffer@0.1.0", "npm:core-util-is@1.0.1", "npm:inherits@2.0.1", "npm:stream-browserify@1.0.0/index", "npm:readable-stream@1.1.13/lib/_stream_duplex", "npm:readable-stream@1.1.13/lib/_stream_duplex", "github:jspm/nodelibs-buffer@0.1.0", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer, process) {
    module.exports = Writable;
    var Buffer = require("github:jspm/nodelibs-buffer@0.1.0").Buffer;
    Writable.WritableState = WritableState;
    var util = require("npm:core-util-is@1.0.1");
    util.inherits = require("npm:inherits@2.0.1");
    var Stream = require("npm:stream-browserify@1.0.0/index");
    util.inherits(Writable, Stream);
    function WriteReq(chunk, encoding, cb) {
      this.chunk = chunk;
      this.encoding = encoding;
      this.callback = cb;
    }
    function WritableState(options, stream) {
      var Duplex = require("npm:readable-stream@1.1.13/lib/_stream_duplex");
      options = options || {};
      var hwm = options.highWaterMark;
      var defaultHwm = options.objectMode ? 16 : 16 * 1024;
      this.highWaterMark = (hwm || hwm === 0) ? hwm : defaultHwm;
      this.objectMode = !!options.objectMode;
      if (stream instanceof Duplex)
        this.objectMode = this.objectMode || !!options.writableObjectMode;
      this.highWaterMark = ~~this.highWaterMark;
      this.needDrain = false;
      this.ending = false;
      this.ended = false;
      this.finished = false;
      var noDecode = options.decodeStrings === false;
      this.decodeStrings = !noDecode;
      this.defaultEncoding = options.defaultEncoding || 'utf8';
      this.length = 0;
      this.writing = false;
      this.corked = 0;
      this.sync = true;
      this.bufferProcessing = false;
      this.onwrite = function(er) {
        onwrite(stream, er);
      };
      this.writecb = null;
      this.writelen = 0;
      this.buffer = [];
      this.pendingcb = 0;
      this.prefinished = false;
      this.errorEmitted = false;
    }
    function Writable(options) {
      var Duplex = require("npm:readable-stream@1.1.13/lib/_stream_duplex");
      if (!(this instanceof Writable) && !(this instanceof Duplex))
        return new Writable(options);
      this._writableState = new WritableState(options, this);
      this.writable = true;
      Stream.call(this);
    }
    Writable.prototype.pipe = function() {
      this.emit('error', new Error('Cannot pipe. Not readable.'));
    };
    function writeAfterEnd(stream, state, cb) {
      var er = new Error('write after end');
      stream.emit('error', er);
      process.nextTick(function() {
        cb(er);
      });
    }
    function validChunk(stream, state, chunk, cb) {
      var valid = true;
      if (!util.isBuffer(chunk) && !util.isString(chunk) && !util.isNullOrUndefined(chunk) && !state.objectMode) {
        var er = new TypeError('Invalid non-string/buffer chunk');
        stream.emit('error', er);
        process.nextTick(function() {
          cb(er);
        });
        valid = false;
      }
      return valid;
    }
    Writable.prototype.write = function(chunk, encoding, cb) {
      var state = this._writableState;
      var ret = false;
      if (util.isFunction(encoding)) {
        cb = encoding;
        encoding = null;
      }
      if (util.isBuffer(chunk))
        encoding = 'buffer';
      else if (!encoding)
        encoding = state.defaultEncoding;
      if (!util.isFunction(cb))
        cb = function() {};
      if (state.ended)
        writeAfterEnd(this, state, cb);
      else if (validChunk(this, state, chunk, cb)) {
        state.pendingcb++;
        ret = writeOrBuffer(this, state, chunk, encoding, cb);
      }
      return ret;
    };
    Writable.prototype.cork = function() {
      var state = this._writableState;
      state.corked++;
    };
    Writable.prototype.uncork = function() {
      var state = this._writableState;
      if (state.corked) {
        state.corked--;
        if (!state.writing && !state.corked && !state.finished && !state.bufferProcessing && state.buffer.length)
          clearBuffer(this, state);
      }
    };
    function decodeChunk(state, chunk, encoding) {
      if (!state.objectMode && state.decodeStrings !== false && util.isString(chunk)) {
        chunk = new Buffer(chunk, encoding);
      }
      return chunk;
    }
    function writeOrBuffer(stream, state, chunk, encoding, cb) {
      chunk = decodeChunk(state, chunk, encoding);
      if (util.isBuffer(chunk))
        encoding = 'buffer';
      var len = state.objectMode ? 1 : chunk.length;
      state.length += len;
      var ret = state.length < state.highWaterMark;
      if (!ret)
        state.needDrain = true;
      if (state.writing || state.corked)
        state.buffer.push(new WriteReq(chunk, encoding, cb));
      else
        doWrite(stream, state, false, len, chunk, encoding, cb);
      return ret;
    }
    function doWrite(stream, state, writev, len, chunk, encoding, cb) {
      state.writelen = len;
      state.writecb = cb;
      state.writing = true;
      state.sync = true;
      if (writev)
        stream._writev(chunk, state.onwrite);
      else
        stream._write(chunk, encoding, state.onwrite);
      state.sync = false;
    }
    function onwriteError(stream, state, sync, er, cb) {
      if (sync)
        process.nextTick(function() {
          state.pendingcb--;
          cb(er);
        });
      else {
        state.pendingcb--;
        cb(er);
      }
      stream._writableState.errorEmitted = true;
      stream.emit('error', er);
    }
    function onwriteStateUpdate(state) {
      state.writing = false;
      state.writecb = null;
      state.length -= state.writelen;
      state.writelen = 0;
    }
    function onwrite(stream, er) {
      var state = stream._writableState;
      var sync = state.sync;
      var cb = state.writecb;
      onwriteStateUpdate(state);
      if (er)
        onwriteError(stream, state, sync, er, cb);
      else {
        var finished = needFinish(stream, state);
        if (!finished && !state.corked && !state.bufferProcessing && state.buffer.length) {
          clearBuffer(stream, state);
        }
        if (sync) {
          process.nextTick(function() {
            afterWrite(stream, state, finished, cb);
          });
        } else {
          afterWrite(stream, state, finished, cb);
        }
      }
    }
    function afterWrite(stream, state, finished, cb) {
      if (!finished)
        onwriteDrain(stream, state);
      state.pendingcb--;
      cb();
      finishMaybe(stream, state);
    }
    function onwriteDrain(stream, state) {
      if (state.length === 0 && state.needDrain) {
        state.needDrain = false;
        stream.emit('drain');
      }
    }
    function clearBuffer(stream, state) {
      state.bufferProcessing = true;
      if (stream._writev && state.buffer.length > 1) {
        var cbs = [];
        for (var c = 0; c < state.buffer.length; c++)
          cbs.push(state.buffer[c].callback);
        state.pendingcb++;
        doWrite(stream, state, true, state.length, state.buffer, '', function(err) {
          for (var i = 0; i < cbs.length; i++) {
            state.pendingcb--;
            cbs[i](err);
          }
        });
        state.buffer = [];
      } else {
        for (var c = 0; c < state.buffer.length; c++) {
          var entry = state.buffer[c];
          var chunk = entry.chunk;
          var encoding = entry.encoding;
          var cb = entry.callback;
          var len = state.objectMode ? 1 : chunk.length;
          doWrite(stream, state, false, len, chunk, encoding, cb);
          if (state.writing) {
            c++;
            break;
          }
        }
        if (c < state.buffer.length)
          state.buffer = state.buffer.slice(c);
        else
          state.buffer.length = 0;
      }
      state.bufferProcessing = false;
    }
    Writable.prototype._write = function(chunk, encoding, cb) {
      cb(new Error('not implemented'));
    };
    Writable.prototype._writev = null;
    Writable.prototype.end = function(chunk, encoding, cb) {
      var state = this._writableState;
      if (util.isFunction(chunk)) {
        cb = chunk;
        chunk = null;
        encoding = null;
      } else if (util.isFunction(encoding)) {
        cb = encoding;
        encoding = null;
      }
      if (!util.isNullOrUndefined(chunk))
        this.write(chunk, encoding);
      if (state.corked) {
        state.corked = 1;
        this.uncork();
      }
      if (!state.ending && !state.finished)
        endWritable(this, state, cb);
    };
    function needFinish(stream, state) {
      return (state.ending && state.length === 0 && !state.finished && !state.writing);
    }
    function prefinish(stream, state) {
      if (!state.prefinished) {
        state.prefinished = true;
        stream.emit('prefinish');
      }
    }
    function finishMaybe(stream, state) {
      var need = needFinish(stream, state);
      if (need) {
        if (state.pendingcb === 0) {
          prefinish(stream, state);
          state.finished = true;
          stream.emit('finish');
        } else
          prefinish(stream, state);
      }
      return need;
    }
    function endWritable(stream, state, cb) {
      state.ending = true;
      finishMaybe(stream, state);
      if (cb) {
        if (state.finished)
          process.nextTick(cb);
        else
          stream.once('finish', cb);
      }
      state.ended = true;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer, require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:string_decoder@0.10.31/index", ["github:jspm/nodelibs-buffer@0.1.0", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var Buffer = require("github:jspm/nodelibs-buffer@0.1.0").Buffer;
    var isBufferEncoding = Buffer.isEncoding || function(encoding) {
      switch (encoding && encoding.toLowerCase()) {
        case 'hex':
        case 'utf8':
        case 'utf-8':
        case 'ascii':
        case 'binary':
        case 'base64':
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
        case 'raw':
          return true;
        default:
          return false;
      }
    };
    function assertEncoding(encoding) {
      if (encoding && !isBufferEncoding(encoding)) {
        throw new Error('Unknown encoding: ' + encoding);
      }
    }
    var StringDecoder = exports.StringDecoder = function(encoding) {
      this.encoding = (encoding || 'utf8').toLowerCase().replace(/[-_]/, '');
      assertEncoding(encoding);
      switch (this.encoding) {
        case 'utf8':
          this.surrogateSize = 3;
          break;
        case 'ucs2':
        case 'utf16le':
          this.surrogateSize = 2;
          this.detectIncompleteChar = utf16DetectIncompleteChar;
          break;
        case 'base64':
          this.surrogateSize = 3;
          this.detectIncompleteChar = base64DetectIncompleteChar;
          break;
        default:
          this.write = passThroughWrite;
          return ;
      }
      this.charBuffer = new Buffer(6);
      this.charReceived = 0;
      this.charLength = 0;
    };
    StringDecoder.prototype.write = function(buffer) {
      var charStr = '';
      while (this.charLength) {
        var available = (buffer.length >= this.charLength - this.charReceived) ? this.charLength - this.charReceived : buffer.length;
        buffer.copy(this.charBuffer, this.charReceived, 0, available);
        this.charReceived += available;
        if (this.charReceived < this.charLength) {
          return '';
        }
        buffer = buffer.slice(available, buffer.length);
        charStr = this.charBuffer.slice(0, this.charLength).toString(this.encoding);
        var charCode = charStr.charCodeAt(charStr.length - 1);
        if (charCode >= 0xD800 && charCode <= 0xDBFF) {
          this.charLength += this.surrogateSize;
          charStr = '';
          continue;
        }
        this.charReceived = this.charLength = 0;
        if (buffer.length === 0) {
          return charStr;
        }
        break;
      }
      this.detectIncompleteChar(buffer);
      var end = buffer.length;
      if (this.charLength) {
        buffer.copy(this.charBuffer, 0, buffer.length - this.charReceived, end);
        end -= this.charReceived;
      }
      charStr += buffer.toString(this.encoding, 0, end);
      var end = charStr.length - 1;
      var charCode = charStr.charCodeAt(end);
      if (charCode >= 0xD800 && charCode <= 0xDBFF) {
        var size = this.surrogateSize;
        this.charLength += size;
        this.charReceived += size;
        this.charBuffer.copy(this.charBuffer, size, 0, size);
        buffer.copy(this.charBuffer, 0, 0, size);
        return charStr.substring(0, end);
      }
      return charStr;
    };
    StringDecoder.prototype.detectIncompleteChar = function(buffer) {
      var i = (buffer.length >= 3) ? 3 : buffer.length;
      for (; i > 0; i--) {
        var c = buffer[buffer.length - i];
        if (i == 1 && c >> 5 == 0x06) {
          this.charLength = 2;
          break;
        }
        if (i <= 2 && c >> 4 == 0x0E) {
          this.charLength = 3;
          break;
        }
        if (i <= 3 && c >> 3 == 0x1E) {
          this.charLength = 4;
          break;
        }
      }
      this.charReceived = i;
    };
    StringDecoder.prototype.end = function(buffer) {
      var res = '';
      if (buffer && buffer.length)
        res = this.write(buffer);
      if (this.charReceived) {
        var cr = this.charReceived;
        var buf = this.charBuffer;
        var enc = this.encoding;
        res += buf.slice(0, cr).toString(enc);
      }
      return res;
    };
    function passThroughWrite(buffer) {
      return buffer.toString(this.encoding);
    }
    function utf16DetectIncompleteChar(buffer) {
      this.charReceived = buffer.length % 2;
      this.charLength = this.charReceived ? 2 : 0;
    }
    function base64DetectIncompleteChar(buffer) {
      this.charReceived = buffer.length % 3;
      this.charLength = this.charReceived ? 3 : 0;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:readable-stream@1.1.13/lib/_stream_transform", ["npm:readable-stream@1.1.13/lib/_stream_duplex", "npm:core-util-is@1.0.1", "npm:inherits@2.0.1", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    module.exports = Transform;
    var Duplex = require("npm:readable-stream@1.1.13/lib/_stream_duplex");
    var util = require("npm:core-util-is@1.0.1");
    util.inherits = require("npm:inherits@2.0.1");
    util.inherits(Transform, Duplex);
    function TransformState(options, stream) {
      this.afterTransform = function(er, data) {
        return afterTransform(stream, er, data);
      };
      this.needTransform = false;
      this.transforming = false;
      this.writecb = null;
      this.writechunk = null;
    }
    function afterTransform(stream, er, data) {
      var ts = stream._transformState;
      ts.transforming = false;
      var cb = ts.writecb;
      if (!cb)
        return stream.emit('error', new Error('no writecb in Transform class'));
      ts.writechunk = null;
      ts.writecb = null;
      if (!util.isNullOrUndefined(data))
        stream.push(data);
      if (cb)
        cb(er);
      var rs = stream._readableState;
      rs.reading = false;
      if (rs.needReadable || rs.length < rs.highWaterMark) {
        stream._read(rs.highWaterMark);
      }
    }
    function Transform(options) {
      if (!(this instanceof Transform))
        return new Transform(options);
      Duplex.call(this, options);
      this._transformState = new TransformState(options, this);
      var stream = this;
      this._readableState.needReadable = true;
      this._readableState.sync = false;
      this.once('prefinish', function() {
        if (util.isFunction(this._flush))
          this._flush(function(er) {
            done(stream, er);
          });
        else
          done(stream);
      });
    }
    Transform.prototype.push = function(chunk, encoding) {
      this._transformState.needTransform = false;
      return Duplex.prototype.push.call(this, chunk, encoding);
    };
    Transform.prototype._transform = function(chunk, encoding, cb) {
      throw new Error('not implemented');
    };
    Transform.prototype._write = function(chunk, encoding, cb) {
      var ts = this._transformState;
      ts.writecb = cb;
      ts.writechunk = chunk;
      ts.writeencoding = encoding;
      if (!ts.transforming) {
        var rs = this._readableState;
        if (ts.needTransform || rs.needReadable || rs.length < rs.highWaterMark)
          this._read(rs.highWaterMark);
      }
    };
    Transform.prototype._read = function(n) {
      var ts = this._transformState;
      if (!util.isNull(ts.writechunk) && ts.writecb && !ts.transforming) {
        ts.transforming = true;
        this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
      } else {
        ts.needTransform = true;
      }
    };
    function done(stream, er) {
      if (er)
        return stream.emit('error', er);
      var ws = stream._writableState;
      var ts = stream._transformState;
      if (ws.length)
        throw new Error('calling transform done when ws.length != 0');
      if (ts.transforming)
        throw new Error('calling transform done when still transforming');
      return stream.push(null);
    }
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:readable-stream@1.1.13/lib/_stream_passthrough", ["npm:readable-stream@1.1.13/lib/_stream_transform", "npm:core-util-is@1.0.1", "npm:inherits@2.0.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = PassThrough;
  var Transform = require("npm:readable-stream@1.1.13/lib/_stream_transform");
  var util = require("npm:core-util-is@1.0.1");
  util.inherits = require("npm:inherits@2.0.1");
  util.inherits(PassThrough, Transform);
  function PassThrough(options) {
    if (!(this instanceof PassThrough))
      return new PassThrough(options);
    Transform.call(this, options);
  }
  PassThrough.prototype._transform = function(chunk, encoding, cb) {
    cb(null, chunk);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:readable-stream@1.1.13/writable", ["npm:readable-stream@1.1.13/lib/_stream_writable"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:readable-stream@1.1.13/lib/_stream_writable");
  global.define = __define;
  return module.exports;
});

System.register("npm:readable-stream@1.1.13/duplex", ["npm:readable-stream@1.1.13/lib/_stream_duplex"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:readable-stream@1.1.13/lib/_stream_duplex");
  global.define = __define;
  return module.exports;
});

System.register("npm:readable-stream@1.1.13/transform", ["npm:readable-stream@1.1.13/lib/_stream_transform"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:readable-stream@1.1.13/lib/_stream_transform");
  global.define = __define;
  return module.exports;
});

System.register("npm:readable-stream@1.1.13/passthrough", ["npm:readable-stream@1.1.13/lib/_stream_passthrough"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:readable-stream@1.1.13/lib/_stream_passthrough");
  global.define = __define;
  return module.exports;
});

System.register("npm:create-hmac@1.1.3/browser", ["npm:create-hash@1.1.1/browser", "npm:inherits@2.0.1", "github:jspm/nodelibs-stream@0.1.0", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    'use strict';
    var createHash = require("npm:create-hash@1.1.1/browser");
    var inherits = require("npm:inherits@2.0.1");
    var Transform = require("github:jspm/nodelibs-stream@0.1.0").Transform;
    var ZEROS = new Buffer(128);
    ZEROS.fill(0);
    function Hmac(alg, key) {
      Transform.call(this);
      if (typeof key === 'string') {
        key = new Buffer(key);
      }
      var blocksize = (alg === 'sha512' || alg === 'sha384') ? 128 : 64;
      this._alg = alg;
      this._key = key;
      if (key.length > blocksize) {
        key = createHash(alg).update(key).digest();
      } else if (key.length < blocksize) {
        key = Buffer.concat([key, ZEROS], blocksize);
      }
      var ipad = this._ipad = new Buffer(blocksize);
      var opad = this._opad = new Buffer(blocksize);
      for (var i = 0; i < blocksize; i++) {
        ipad[i] = key[i] ^ 0x36;
        opad[i] = key[i] ^ 0x5C;
      }
      this._hash = createHash(alg).update(ipad);
    }
    inherits(Hmac, Transform);
    Hmac.prototype.update = function(data, enc) {
      this._hash.update(data, enc);
      return this;
    };
    Hmac.prototype._transform = function(data, _, next) {
      this._hash.update(data);
      next();
    };
    Hmac.prototype._flush = function(next) {
      this.push(this.digest());
      next();
    };
    Hmac.prototype.digest = function(enc) {
      var h = this._hash.digest();
      return createHash(this._alg).update(this._opad).update(h).digest(enc);
    };
    module.exports = function createHmac(alg, key) {
      return new Hmac(alg, key);
    };
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-sign@3.0.1/algos", ["github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    'use strict';
    exports['RSA-SHA224'] = exports.sha224WithRSAEncryption = {
      sign: 'rsa',
      hash: 'sha224',
      id: new Buffer('302d300d06096086480165030402040500041c', 'hex')
    };
    exports['RSA-SHA256'] = exports.sha256WithRSAEncryption = {
      sign: 'rsa',
      hash: 'sha256',
      id: new Buffer('3031300d060960864801650304020105000420', 'hex')
    };
    exports['RSA-SHA384'] = exports.sha384WithRSAEncryption = {
      sign: 'rsa',
      hash: 'sha384',
      id: new Buffer('3041300d060960864801650304020205000430', 'hex')
    };
    exports['RSA-SHA512'] = exports.sha512WithRSAEncryption = {
      sign: 'rsa',
      hash: 'sha512',
      id: new Buffer('3051300d060960864801650304020305000440', 'hex')
    };
    exports['RSA-SHA1'] = {
      sign: 'rsa',
      hash: 'sha1',
      id: new Buffer('3021300906052b0e03021a05000414', 'hex')
    };
    exports['ecdsa-with-SHA1'] = {
      sign: 'ecdsa',
      hash: 'sha1',
      id: new Buffer('', 'hex')
    };
    exports.DSA = exports['DSA-SHA1'] = exports['DSA-SHA'] = {
      sign: 'dsa',
      hash: 'sha1',
      id: new Buffer('', 'hex')
    };
    exports['DSA-SHA224'] = exports['DSA-WITH-SHA224'] = {
      sign: 'dsa',
      hash: 'sha224',
      id: new Buffer('', 'hex')
    };
    exports['DSA-SHA256'] = exports['DSA-WITH-SHA256'] = {
      sign: 'dsa',
      hash: 'sha256',
      id: new Buffer('', 'hex')
    };
    exports['DSA-SHA384'] = exports['DSA-WITH-SHA384'] = {
      sign: 'dsa',
      hash: 'sha384',
      id: new Buffer('', 'hex')
    };
    exports['DSA-SHA512'] = exports['DSA-WITH-SHA512'] = {
      sign: 'dsa',
      hash: 'sha512',
      id: new Buffer('', 'hex')
    };
    exports['DSA-RIPEMD160'] = {
      sign: 'dsa',
      hash: 'rmd160',
      id: new Buffer('', 'hex')
    };
    exports['RSA-RIPEMD160'] = exports.ripemd160WithRSA = {
      sign: 'rsa',
      hash: 'rmd160',
      id: new Buffer('3021300906052b2403020105000414', 'hex')
    };
    exports['RSA-MD5'] = exports.md5WithRSAEncryption = {
      sign: 'rsa',
      hash: 'md5',
      id: new Buffer('3020300c06082a864886f70d020505000410', 'hex')
    };
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:pbkdf2@3.0.4/browser", ["npm:create-hmac@1.1.3", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var createHmac = require("npm:create-hmac@1.1.3");
    var MAX_ALLOC = Math.pow(2, 30) - 1;
    exports.pbkdf2 = pbkdf2;
    function pbkdf2(password, salt, iterations, keylen, digest, callback) {
      if (typeof digest === 'function') {
        callback = digest;
        digest = undefined;
      }
      if (typeof callback !== 'function') {
        throw new Error('No callback provided to pbkdf2');
      }
      var result = pbkdf2Sync(password, salt, iterations, keylen, digest);
      setTimeout(function() {
        callback(undefined, result);
      });
    }
    exports.pbkdf2Sync = pbkdf2Sync;
    function pbkdf2Sync(password, salt, iterations, keylen, digest) {
      if (typeof iterations !== 'number') {
        throw new TypeError('Iterations not a number');
      }
      if (iterations < 0) {
        throw new TypeError('Bad iterations');
      }
      if (typeof keylen !== 'number') {
        throw new TypeError('Key length not a number');
      }
      if (keylen < 0 || keylen > MAX_ALLOC) {
        throw new TypeError('Bad key length');
      }
      digest = digest || 'sha1';
      if (!Buffer.isBuffer(password))
        password = new Buffer(password, 'binary');
      if (!Buffer.isBuffer(salt))
        salt = new Buffer(salt, 'binary');
      var hLen;
      var l = 1;
      var DK = new Buffer(keylen);
      var block1 = new Buffer(salt.length + 4);
      salt.copy(block1, 0, 0, salt.length);
      var r;
      var T;
      for (var i = 1; i <= l; i++) {
        block1.writeUInt32BE(i, salt.length);
        var U = createHmac(digest, password).update(block1).digest();
        if (!hLen) {
          hLen = U.length;
          T = new Buffer(hLen);
          l = Math.ceil(keylen / hLen);
          r = keylen - (l - 1) * hLen;
        }
        U.copy(T, 0, 0, hLen);
        for (var j = 1; j < iterations; j++) {
          U = createHmac(digest, password).update(U).digest();
          for (var k = 0; k < hLen; k++) {
            T[k] ^= U[k];
          }
        }
        var destPos = (i - 1) * hLen;
        var len = (i === l ? r : hLen);
        T.copy(DK, destPos, 0, len);
      }
      return DK;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/aes", ["github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var uint_max = Math.pow(2, 32);
    function fixup_uint32(x) {
      var ret,
          x_pos;
      ret = x > uint_max || x < 0 ? (x_pos = Math.abs(x) % uint_max, x < 0 ? uint_max - x_pos : x_pos) : x;
      return ret;
    }
    function scrub_vec(v) {
      var i,
          _i,
          _ref;
      for (i = _i = 0, _ref = v.length; 0 <= _ref ? _i < _ref : _i > _ref; i = 0 <= _ref ? ++_i : --_i) {
        v[i] = 0;
      }
      return false;
    }
    function Global() {
      var i;
      this.SBOX = [];
      this.INV_SBOX = [];
      this.SUB_MIX = (function() {
        var _i,
            _results;
        _results = [];
        for (i = _i = 0; _i < 4; i = ++_i) {
          _results.push([]);
        }
        return _results;
      })();
      this.INV_SUB_MIX = (function() {
        var _i,
            _results;
        _results = [];
        for (i = _i = 0; _i < 4; i = ++_i) {
          _results.push([]);
        }
        return _results;
      })();
      this.init();
      this.RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
    }
    Global.prototype.init = function() {
      var d,
          i,
          sx,
          t,
          x,
          x2,
          x4,
          x8,
          xi,
          _i;
      d = (function() {
        var _i,
            _results;
        _results = [];
        for (i = _i = 0; _i < 256; i = ++_i) {
          if (i < 128) {
            _results.push(i << 1);
          } else {
            _results.push((i << 1) ^ 0x11b);
          }
        }
        return _results;
      })();
      x = 0;
      xi = 0;
      for (i = _i = 0; _i < 256; i = ++_i) {
        sx = xi ^ (xi << 1) ^ (xi << 2) ^ (xi << 3) ^ (xi << 4);
        sx = (sx >>> 8) ^ (sx & 0xff) ^ 0x63;
        this.SBOX[x] = sx;
        this.INV_SBOX[sx] = x;
        x2 = d[x];
        x4 = d[x2];
        x8 = d[x4];
        t = (d[sx] * 0x101) ^ (sx * 0x1010100);
        this.SUB_MIX[0][x] = (t << 24) | (t >>> 8);
        this.SUB_MIX[1][x] = (t << 16) | (t >>> 16);
        this.SUB_MIX[2][x] = (t << 8) | (t >>> 24);
        this.SUB_MIX[3][x] = t;
        t = (x8 * 0x1010101) ^ (x4 * 0x10001) ^ (x2 * 0x101) ^ (x * 0x1010100);
        this.INV_SUB_MIX[0][sx] = (t << 24) | (t >>> 8);
        this.INV_SUB_MIX[1][sx] = (t << 16) | (t >>> 16);
        this.INV_SUB_MIX[2][sx] = (t << 8) | (t >>> 24);
        this.INV_SUB_MIX[3][sx] = t;
        if (x === 0) {
          x = xi = 1;
        } else {
          x = x2 ^ d[d[d[x8 ^ x2]]];
          xi ^= d[d[xi]];
        }
      }
      return true;
    };
    var G = new Global();
    AES.blockSize = 4 * 4;
    AES.prototype.blockSize = AES.blockSize;
    AES.keySize = 256 / 8;
    AES.prototype.keySize = AES.keySize;
    function bufferToArray(buf) {
      var len = buf.length / 4;
      var out = new Array(len);
      var i = -1;
      while (++i < len) {
        out[i] = buf.readUInt32BE(i * 4);
      }
      return out;
    }
    function AES(key) {
      this._key = bufferToArray(key);
      this._doReset();
    }
    AES.prototype._doReset = function() {
      var invKsRow,
          keySize,
          keyWords,
          ksRow,
          ksRows,
          t,
          _i,
          _j;
      keyWords = this._key;
      keySize = keyWords.length;
      this._nRounds = keySize + 6;
      ksRows = (this._nRounds + 1) * 4;
      this._keySchedule = [];
      for (ksRow = _i = 0; 0 <= ksRows ? _i < ksRows : _i > ksRows; ksRow = 0 <= ksRows ? ++_i : --_i) {
        this._keySchedule[ksRow] = ksRow < keySize ? keyWords[ksRow] : (t = this._keySchedule[ksRow - 1], (ksRow % keySize) === 0 ? (t = (t << 8) | (t >>> 24), t = (G.SBOX[t >>> 24] << 24) | (G.SBOX[(t >>> 16) & 0xff] << 16) | (G.SBOX[(t >>> 8) & 0xff] << 8) | G.SBOX[t & 0xff], t ^= G.RCON[(ksRow / keySize) | 0] << 24) : keySize > 6 && ksRow % keySize === 4 ? t = (G.SBOX[t >>> 24] << 24) | (G.SBOX[(t >>> 16) & 0xff] << 16) | (G.SBOX[(t >>> 8) & 0xff] << 8) | G.SBOX[t & 0xff] : void 0, this._keySchedule[ksRow - keySize] ^ t);
      }
      this._invKeySchedule = [];
      for (invKsRow = _j = 0; 0 <= ksRows ? _j < ksRows : _j > ksRows; invKsRow = 0 <= ksRows ? ++_j : --_j) {
        ksRow = ksRows - invKsRow;
        t = this._keySchedule[ksRow - (invKsRow % 4 ? 0 : 4)];
        this._invKeySchedule[invKsRow] = invKsRow < 4 || ksRow <= 4 ? t : G.INV_SUB_MIX[0][G.SBOX[t >>> 24]] ^ G.INV_SUB_MIX[1][G.SBOX[(t >>> 16) & 0xff]] ^ G.INV_SUB_MIX[2][G.SBOX[(t >>> 8) & 0xff]] ^ G.INV_SUB_MIX[3][G.SBOX[t & 0xff]];
      }
      return true;
    };
    AES.prototype.encryptBlock = function(M) {
      M = bufferToArray(new Buffer(M));
      var out = this._doCryptBlock(M, this._keySchedule, G.SUB_MIX, G.SBOX);
      var buf = new Buffer(16);
      buf.writeUInt32BE(out[0], 0);
      buf.writeUInt32BE(out[1], 4);
      buf.writeUInt32BE(out[2], 8);
      buf.writeUInt32BE(out[3], 12);
      return buf;
    };
    AES.prototype.decryptBlock = function(M) {
      M = bufferToArray(new Buffer(M));
      var temp = [M[3], M[1]];
      M[1] = temp[0];
      M[3] = temp[1];
      var out = this._doCryptBlock(M, this._invKeySchedule, G.INV_SUB_MIX, G.INV_SBOX);
      var buf = new Buffer(16);
      buf.writeUInt32BE(out[0], 0);
      buf.writeUInt32BE(out[3], 4);
      buf.writeUInt32BE(out[2], 8);
      buf.writeUInt32BE(out[1], 12);
      return buf;
    };
    AES.prototype.scrub = function() {
      scrub_vec(this._keySchedule);
      scrub_vec(this._invKeySchedule);
      scrub_vec(this._key);
    };
    AES.prototype._doCryptBlock = function(M, keySchedule, SUB_MIX, SBOX) {
      var ksRow,
          round,
          s0,
          s1,
          s2,
          s3,
          t0,
          t1,
          t2,
          t3,
          _i,
          _ref;
      s0 = M[0] ^ keySchedule[0];
      s1 = M[1] ^ keySchedule[1];
      s2 = M[2] ^ keySchedule[2];
      s3 = M[3] ^ keySchedule[3];
      ksRow = 4;
      for (round = _i = 1, _ref = this._nRounds; 1 <= _ref ? _i < _ref : _i > _ref; round = 1 <= _ref ? ++_i : --_i) {
        t0 = SUB_MIX[0][s0 >>> 24] ^ SUB_MIX[1][(s1 >>> 16) & 0xff] ^ SUB_MIX[2][(s2 >>> 8) & 0xff] ^ SUB_MIX[3][s3 & 0xff] ^ keySchedule[ksRow++];
        t1 = SUB_MIX[0][s1 >>> 24] ^ SUB_MIX[1][(s2 >>> 16) & 0xff] ^ SUB_MIX[2][(s3 >>> 8) & 0xff] ^ SUB_MIX[3][s0 & 0xff] ^ keySchedule[ksRow++];
        t2 = SUB_MIX[0][s2 >>> 24] ^ SUB_MIX[1][(s3 >>> 16) & 0xff] ^ SUB_MIX[2][(s0 >>> 8) & 0xff] ^ SUB_MIX[3][s1 & 0xff] ^ keySchedule[ksRow++];
        t3 = SUB_MIX[0][s3 >>> 24] ^ SUB_MIX[1][(s0 >>> 16) & 0xff] ^ SUB_MIX[2][(s1 >>> 8) & 0xff] ^ SUB_MIX[3][s2 & 0xff] ^ keySchedule[ksRow++];
        s0 = t0;
        s1 = t1;
        s2 = t2;
        s3 = t3;
      }
      t0 = ((SBOX[s0 >>> 24] << 24) | (SBOX[(s1 >>> 16) & 0xff] << 16) | (SBOX[(s2 >>> 8) & 0xff] << 8) | SBOX[s3 & 0xff]) ^ keySchedule[ksRow++];
      t1 = ((SBOX[s1 >>> 24] << 24) | (SBOX[(s2 >>> 16) & 0xff] << 16) | (SBOX[(s3 >>> 8) & 0xff] << 8) | SBOX[s0 & 0xff]) ^ keySchedule[ksRow++];
      t2 = ((SBOX[s2 >>> 24] << 24) | (SBOX[(s3 >>> 16) & 0xff] << 16) | (SBOX[(s0 >>> 8) & 0xff] << 8) | SBOX[s1 & 0xff]) ^ keySchedule[ksRow++];
      t3 = ((SBOX[s3 >>> 24] << 24) | (SBOX[(s0 >>> 16) & 0xff] << 16) | (SBOX[(s1 >>> 8) & 0xff] << 8) | SBOX[s2 & 0xff]) ^ keySchedule[ksRow++];
      return [fixup_uint32(t0), fixup_uint32(t1), fixup_uint32(t2), fixup_uint32(t3)];
    };
    exports.AES = AES;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/cipherBase", ["github:jspm/nodelibs-stream@0.1.0", "npm:inherits@2.0.1", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var Transform = require("github:jspm/nodelibs-stream@0.1.0").Transform;
    var inherits = require("npm:inherits@2.0.1");
    module.exports = CipherBase;
    inherits(CipherBase, Transform);
    function CipherBase() {
      Transform.call(this);
    }
    CipherBase.prototype.update = function(data, inputEnc, outputEnc) {
      if (typeof data === 'string') {
        data = new Buffer(data, inputEnc);
      }
      var outData = this._update(data);
      if (outputEnc) {
        outData = outData.toString(outputEnc);
      }
      return outData;
    };
    CipherBase.prototype._transform = function(data, _, next) {
      this.push(this._update(data));
      next();
    };
    CipherBase.prototype._flush = function(next) {
      try {
        this.push(this._final());
      } catch (e) {
        return next(e);
      }
      next();
    };
    CipherBase.prototype.final = function(outputEnc) {
      var outData = this._final() || new Buffer('');
      if (outputEnc) {
        outData = outData.toString(outputEnc);
      }
      return outData;
    };
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/modes", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  exports['aes-128-ecb'] = {
    cipher: 'AES',
    key: 128,
    iv: 0,
    mode: 'ECB',
    type: 'block'
  };
  exports['aes-192-ecb'] = {
    cipher: 'AES',
    key: 192,
    iv: 0,
    mode: 'ECB',
    type: 'block'
  };
  exports['aes-256-ecb'] = {
    cipher: 'AES',
    key: 256,
    iv: 0,
    mode: 'ECB',
    type: 'block'
  };
  exports['aes-128-cbc'] = {
    cipher: 'AES',
    key: 128,
    iv: 16,
    mode: 'CBC',
    type: 'block'
  };
  exports['aes-192-cbc'] = {
    cipher: 'AES',
    key: 192,
    iv: 16,
    mode: 'CBC',
    type: 'block'
  };
  exports['aes-256-cbc'] = {
    cipher: 'AES',
    key: 256,
    iv: 16,
    mode: 'CBC',
    type: 'block'
  };
  exports['aes128'] = exports['aes-128-cbc'];
  exports['aes192'] = exports['aes-192-cbc'];
  exports['aes256'] = exports['aes-256-cbc'];
  exports['aes-128-cfb'] = {
    cipher: 'AES',
    key: 128,
    iv: 16,
    mode: 'CFB',
    type: 'stream'
  };
  exports['aes-192-cfb'] = {
    cipher: 'AES',
    key: 192,
    iv: 16,
    mode: 'CFB',
    type: 'stream'
  };
  exports['aes-256-cfb'] = {
    cipher: 'AES',
    key: 256,
    iv: 16,
    mode: 'CFB',
    type: 'stream'
  };
  exports['aes-128-cfb8'] = {
    cipher: 'AES',
    key: 128,
    iv: 16,
    mode: 'CFB8',
    type: 'stream'
  };
  exports['aes-192-cfb8'] = {
    cipher: 'AES',
    key: 192,
    iv: 16,
    mode: 'CFB8',
    type: 'stream'
  };
  exports['aes-256-cfb8'] = {
    cipher: 'AES',
    key: 256,
    iv: 16,
    mode: 'CFB8',
    type: 'stream'
  };
  exports['aes-128-cfb1'] = {
    cipher: 'AES',
    key: 128,
    iv: 16,
    mode: 'CFB1',
    type: 'stream'
  };
  exports['aes-192-cfb1'] = {
    cipher: 'AES',
    key: 192,
    iv: 16,
    mode: 'CFB1',
    type: 'stream'
  };
  exports['aes-256-cfb1'] = {
    cipher: 'AES',
    key: 256,
    iv: 16,
    mode: 'CFB1',
    type: 'stream'
  };
  exports['aes-128-ofb'] = {
    cipher: 'AES',
    key: 128,
    iv: 16,
    mode: 'OFB',
    type: 'stream'
  };
  exports['aes-192-ofb'] = {
    cipher: 'AES',
    key: 192,
    iv: 16,
    mode: 'OFB',
    type: 'stream'
  };
  exports['aes-256-ofb'] = {
    cipher: 'AES',
    key: 256,
    iv: 16,
    mode: 'OFB',
    type: 'stream'
  };
  exports['aes-128-ctr'] = {
    cipher: 'AES',
    key: 128,
    iv: 16,
    mode: 'CTR',
    type: 'stream'
  };
  exports['aes-192-ctr'] = {
    cipher: 'AES',
    key: 192,
    iv: 16,
    mode: 'CTR',
    type: 'stream'
  };
  exports['aes-256-ctr'] = {
    cipher: 'AES',
    key: 256,
    iv: 16,
    mode: 'CTR',
    type: 'stream'
  };
  exports['aes-128-gcm'] = {
    cipher: 'AES',
    key: 128,
    iv: 12,
    mode: 'GCM',
    type: 'auth'
  };
  exports['aes-192-gcm'] = {
    cipher: 'AES',
    key: 192,
    iv: 12,
    mode: 'GCM',
    type: 'auth'
  };
  exports['aes-256-gcm'] = {
    cipher: 'AES',
    key: 256,
    iv: 12,
    mode: 'GCM',
    type: 'auth'
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/EVP_BytesToKey", ["npm:create-hash@1.1.1/md5", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var md5 = require("npm:create-hash@1.1.1/md5");
    module.exports = EVP_BytesToKey;
    function EVP_BytesToKey(password, keyLen, ivLen) {
      if (!Buffer.isBuffer(password)) {
        password = new Buffer(password, 'binary');
      }
      keyLen = keyLen / 8;
      ivLen = ivLen || 0;
      var ki = 0;
      var ii = 0;
      var key = new Buffer(keyLen);
      var iv = new Buffer(ivLen);
      var addmd = 0;
      var md_buf;
      var i;
      var bufs = [];
      while (true) {
        if (addmd++ > 0) {
          bufs.push(md_buf);
        }
        bufs.push(password);
        md_buf = md5(Buffer.concat(bufs));
        bufs = [];
        i = 0;
        if (keyLen > 0) {
          while (true) {
            if (keyLen === 0) {
              break;
            }
            if (i === md_buf.length) {
              break;
            }
            key[ki++] = md_buf[i];
            keyLen--;
            i++;
          }
        }
        if (ivLen > 0 && i !== md_buf.length) {
          while (true) {
            if (ivLen === 0) {
              break;
            }
            if (i === md_buf.length) {
              break;
            }
            iv[ii++] = md_buf[i];
            ivLen--;
            i++;
          }
        }
        if (keyLen === 0 && ivLen === 0) {
          break;
        }
      }
      for (i = 0; i < md_buf.length; i++) {
        md_buf[i] = 0;
      }
      return {
        key: key,
        iv: iv
      };
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/streamCipher", ["npm:browserify-aes@1.0.0/aes", "npm:browserify-aes@1.0.0/cipherBase", "npm:inherits@2.0.1", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var aes = require("npm:browserify-aes@1.0.0/aes");
    var Transform = require("npm:browserify-aes@1.0.0/cipherBase");
    var inherits = require("npm:inherits@2.0.1");
    inherits(StreamCipher, Transform);
    module.exports = StreamCipher;
    function StreamCipher(mode, key, iv, decrypt) {
      if (!(this instanceof StreamCipher)) {
        return new StreamCipher(mode, key, iv);
      }
      Transform.call(this);
      this._cipher = new aes.AES(key);
      this._prev = new Buffer(iv.length);
      this._cache = new Buffer('');
      this._secCache = new Buffer('');
      this._decrypt = decrypt;
      iv.copy(this._prev);
      this._mode = mode;
    }
    StreamCipher.prototype._update = function(chunk) {
      return this._mode.encrypt(this, chunk, this._decrypt);
    };
    StreamCipher.prototype._final = function() {
      this._cipher.scrub();
    };
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/ghash", ["github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var zeros = new Buffer(16);
    zeros.fill(0);
    module.exports = GHASH;
    function GHASH(key) {
      this.h = key;
      this.state = new Buffer(16);
      this.state.fill(0);
      this.cache = new Buffer('');
    }
    GHASH.prototype.ghash = function(block) {
      var i = -1;
      while (++i < block.length) {
        this.state[i] ^= block[i];
      }
      this._multiply();
    };
    GHASH.prototype._multiply = function() {
      var Vi = toArray(this.h);
      var Zi = [0, 0, 0, 0];
      var j,
          xi,
          lsb_Vi;
      var i = -1;
      while (++i < 128) {
        xi = (this.state[~~(i / 8)] & (1 << (7 - i % 8))) !== 0;
        if (xi) {
          Zi = xor(Zi, Vi);
        }
        lsb_Vi = (Vi[3] & 1) !== 0;
        for (j = 3; j > 0; j--) {
          Vi[j] = (Vi[j] >>> 1) | ((Vi[j - 1] & 1) << 31);
        }
        Vi[0] = Vi[0] >>> 1;
        if (lsb_Vi) {
          Vi[0] = Vi[0] ^ (0xe1 << 24);
        }
      }
      this.state = fromArray(Zi);
    };
    GHASH.prototype.update = function(buf) {
      this.cache = Buffer.concat([this.cache, buf]);
      var chunk;
      while (this.cache.length >= 16) {
        chunk = this.cache.slice(0, 16);
        this.cache = this.cache.slice(16);
        this.ghash(chunk);
      }
    };
    GHASH.prototype.final = function(abl, bl) {
      if (this.cache.length) {
        this.ghash(Buffer.concat([this.cache, zeros], 16));
      }
      this.ghash(fromArray([0, abl, 0, bl]));
      return this.state;
    };
    function toArray(buf) {
      return [buf.readUInt32BE(0), buf.readUInt32BE(4), buf.readUInt32BE(8), buf.readUInt32BE(12)];
    }
    function fromArray(out) {
      out = out.map(fixup_uint32);
      var buf = new Buffer(16);
      buf.writeUInt32BE(out[0], 0);
      buf.writeUInt32BE(out[1], 4);
      buf.writeUInt32BE(out[2], 8);
      buf.writeUInt32BE(out[3], 12);
      return buf;
    }
    var uint_max = Math.pow(2, 32);
    function fixup_uint32(x) {
      var ret,
          x_pos;
      ret = x > uint_max || x < 0 ? (x_pos = Math.abs(x) % uint_max, x < 0 ? uint_max - x_pos : x_pos) : x;
      return ret;
    }
    function xor(a, b) {
      return [a[0] ^ b[0], a[1] ^ b[1], a[2] ^ b[2], a[3] ^ b[3]];
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/xor", ["github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    module.exports = xor;
    function xor(a, b) {
      var len = Math.min(a.length, b.length);
      var out = new Buffer(len);
      var i = -1;
      while (++i < len) {
        out.writeUInt8(a[i] ^ b[i], i);
      }
      return out;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/modes/ecb", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  exports.encrypt = function(self, block) {
    return self._cipher.encryptBlock(block);
  };
  exports.decrypt = function(self, block) {
    return self._cipher.decryptBlock(block);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/modes/cbc", ["npm:browserify-aes@1.0.0/xor"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var xor = require("npm:browserify-aes@1.0.0/xor");
  exports.encrypt = function(self, block) {
    var data = xor(block, self._prev);
    self._prev = self._cipher.encryptBlock(data);
    return self._prev;
  };
  exports.decrypt = function(self, block) {
    var pad = self._prev;
    self._prev = block;
    var out = self._cipher.decryptBlock(block);
    return xor(out, pad);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/modes/cfb", ["npm:browserify-aes@1.0.0/xor", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var xor = require("npm:browserify-aes@1.0.0/xor");
    exports.encrypt = function(self, data, decrypt) {
      var out = new Buffer('');
      var len;
      while (data.length) {
        if (self._cache.length === 0) {
          self._cache = self._cipher.encryptBlock(self._prev);
          self._prev = new Buffer('');
        }
        if (self._cache.length <= data.length) {
          len = self._cache.length;
          out = Buffer.concat([out, encryptStart(self, data.slice(0, len), decrypt)]);
          data = data.slice(len);
        } else {
          out = Buffer.concat([out, encryptStart(self, data, decrypt)]);
          break;
        }
      }
      return out;
    };
    function encryptStart(self, data, decrypt) {
      var len = data.length;
      var out = xor(data, self._cache);
      self._cache = self._cache.slice(len);
      self._prev = Buffer.concat([self._prev, decrypt ? data : out]);
      return out;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/modes/cfb8", ["github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    function encryptByte(self, byte, decrypt) {
      var pad = self._cipher.encryptBlock(self._prev);
      var out = pad[0] ^ byte;
      self._prev = Buffer.concat([self._prev.slice(1), new Buffer([decrypt ? byte : out])]);
      return out;
    }
    exports.encrypt = function(self, chunk, decrypt) {
      var len = chunk.length;
      var out = new Buffer(len);
      var i = -1;
      while (++i < len) {
        out[i] = encryptByte(self, chunk[i], decrypt);
      }
      return out;
    };
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/modes/cfb1", ["github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    function encryptByte(self, byte, decrypt) {
      var pad;
      var i = -1;
      var len = 8;
      var out = 0;
      var bit,
          value;
      while (++i < len) {
        pad = self._cipher.encryptBlock(self._prev);
        bit = (byte & (1 << (7 - i))) ? 0x80 : 0;
        value = pad[0] ^ bit;
        out += ((value & 0x80) >> (i % 8));
        self._prev = shiftIn(self._prev, decrypt ? bit : value);
      }
      return out;
    }
    exports.encrypt = function(self, chunk, decrypt) {
      var len = chunk.length;
      var out = new Buffer(len);
      var i = -1;
      while (++i < len) {
        out[i] = encryptByte(self, chunk[i], decrypt);
      }
      return out;
    };
    function shiftIn(buffer, value) {
      var len = buffer.length;
      var i = -1;
      var out = new Buffer(buffer.length);
      buffer = Buffer.concat([buffer, new Buffer([value])]);
      while (++i < len) {
        out[i] = buffer[i] << 1 | buffer[i + 1] >> (7);
      }
      return out;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/modes/ofb", ["npm:browserify-aes@1.0.0/xor", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var xor = require("npm:browserify-aes@1.0.0/xor");
    function getBlock(self) {
      self._prev = self._cipher.encryptBlock(self._prev);
      return self._prev;
    }
    exports.encrypt = function(self, chunk) {
      while (self._cache.length < chunk.length) {
        self._cache = Buffer.concat([self._cache, getBlock(self)]);
      }
      var pad = self._cache.slice(0, chunk.length);
      self._cache = self._cache.slice(chunk.length);
      return xor(chunk, pad);
    };
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/modes/ctr", ["npm:browserify-aes@1.0.0/xor", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var xor = require("npm:browserify-aes@1.0.0/xor");
    function getBlock(self) {
      var out = self._cipher.encryptBlock(self._prev);
      incr32(self._prev);
      return out;
    }
    exports.encrypt = function(self, chunk) {
      while (self._cache.length < chunk.length) {
        self._cache = Buffer.concat([self._cache, getBlock(self)]);
      }
      var pad = self._cache.slice(0, chunk.length);
      self._cache = self._cache.slice(chunk.length);
      return xor(chunk, pad);
    };
    function incr32(iv) {
      var len = iv.length;
      var item;
      while (len--) {
        item = iv.readUInt8(len);
        if (item === 255) {
          iv.writeUInt8(0, len);
        } else {
          item++;
          iv.writeUInt8(item, len);
          break;
        }
      }
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/decrypter", ["npm:browserify-aes@1.0.0/aes", "npm:browserify-aes@1.0.0/cipherBase", "npm:inherits@2.0.1", "npm:browserify-aes@1.0.0/modes", "npm:browserify-aes@1.0.0/streamCipher", "npm:browserify-aes@1.0.0/authCipher", "npm:browserify-aes@1.0.0/EVP_BytesToKey", "npm:browserify-aes@1.0.0/modes/ecb", "npm:browserify-aes@1.0.0/modes/cbc", "npm:browserify-aes@1.0.0/modes/cfb", "npm:browserify-aes@1.0.0/modes/cfb8", "npm:browserify-aes@1.0.0/modes/cfb1", "npm:browserify-aes@1.0.0/modes/ofb", "npm:browserify-aes@1.0.0/modes/ctr", "npm:browserify-aes@1.0.0/modes/ctr", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var aes = require("npm:browserify-aes@1.0.0/aes");
    var Transform = require("npm:browserify-aes@1.0.0/cipherBase");
    var inherits = require("npm:inherits@2.0.1");
    var modes = require("npm:browserify-aes@1.0.0/modes");
    var StreamCipher = require("npm:browserify-aes@1.0.0/streamCipher");
    var AuthCipher = require("npm:browserify-aes@1.0.0/authCipher");
    var ebtk = require("npm:browserify-aes@1.0.0/EVP_BytesToKey");
    inherits(Decipher, Transform);
    function Decipher(mode, key, iv) {
      if (!(this instanceof Decipher)) {
        return new Decipher(mode, key, iv);
      }
      Transform.call(this);
      this._cache = new Splitter();
      this._last = void 0;
      this._cipher = new aes.AES(key);
      this._prev = new Buffer(iv.length);
      iv.copy(this._prev);
      this._mode = mode;
      this._autopadding = true;
    }
    Decipher.prototype._update = function(data) {
      this._cache.add(data);
      var chunk;
      var thing;
      var out = [];
      while ((chunk = this._cache.get(this._autopadding))) {
        thing = this._mode.decrypt(this, chunk);
        out.push(thing);
      }
      return Buffer.concat(out);
    };
    Decipher.prototype._final = function() {
      var chunk = this._cache.flush();
      if (this._autopadding) {
        return unpad(this._mode.decrypt(this, chunk));
      } else if (chunk) {
        throw new Error('data not multiple of block length');
      }
    };
    Decipher.prototype.setAutoPadding = function(setTo) {
      this._autopadding = !!setTo;
    };
    function Splitter() {
      if (!(this instanceof Splitter)) {
        return new Splitter();
      }
      this.cache = new Buffer('');
    }
    Splitter.prototype.add = function(data) {
      this.cache = Buffer.concat([this.cache, data]);
    };
    Splitter.prototype.get = function(autoPadding) {
      var out;
      if (autoPadding) {
        if (this.cache.length > 16) {
          out = this.cache.slice(0, 16);
          this.cache = this.cache.slice(16);
          return out;
        }
      } else {
        if (this.cache.length >= 16) {
          out = this.cache.slice(0, 16);
          this.cache = this.cache.slice(16);
          return out;
        }
      }
      return null;
    };
    Splitter.prototype.flush = function() {
      if (this.cache.length) {
        return this.cache;
      }
    };
    function unpad(last) {
      var padded = last[15];
      var i = -1;
      while (++i < padded) {
        if (last[(i + (16 - padded))] !== padded) {
          throw new Error('unable to decrypt data');
        }
      }
      if (padded === 16) {
        return ;
      }
      return last.slice(0, 16 - padded);
    }
    var modelist = {
      ECB: require("npm:browserify-aes@1.0.0/modes/ecb"),
      CBC: require("npm:browserify-aes@1.0.0/modes/cbc"),
      CFB: require("npm:browserify-aes@1.0.0/modes/cfb"),
      CFB8: require("npm:browserify-aes@1.0.0/modes/cfb8"),
      CFB1: require("npm:browserify-aes@1.0.0/modes/cfb1"),
      OFB: require("npm:browserify-aes@1.0.0/modes/ofb"),
      CTR: require("npm:browserify-aes@1.0.0/modes/ctr"),
      GCM: require("npm:browserify-aes@1.0.0/modes/ctr")
    };
    function createDecipheriv(suite, password, iv) {
      var config = modes[suite.toLowerCase()];
      if (!config) {
        throw new TypeError('invalid suite type');
      }
      if (typeof iv === 'string') {
        iv = new Buffer(iv);
      }
      if (typeof password === 'string') {
        password = new Buffer(password);
      }
      if (password.length !== config.key / 8) {
        throw new TypeError('invalid key length ' + password.length);
      }
      if (iv.length !== config.iv) {
        throw new TypeError('invalid iv length ' + iv.length);
      }
      if (config.type === 'stream') {
        return new StreamCipher(modelist[config.mode], password, iv, true);
      } else if (config.type === 'auth') {
        return new AuthCipher(modelist[config.mode], password, iv, true);
      }
      return new Decipher(modelist[config.mode], password, iv);
    }
    function createDecipher(suite, password) {
      var config = modes[suite.toLowerCase()];
      if (!config) {
        throw new TypeError('invalid suite type');
      }
      var keys = ebtk(password, config.key, config.iv);
      return createDecipheriv(suite, keys.key, keys.iv);
    }
    exports.createDecipher = createDecipher;
    exports.createDecipheriv = createDecipheriv;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:bn.js@1.3.0/lib/bn", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(module, exports) {
    'use strict';
    function assert(val, msg) {
      if (!val)
        throw new Error(msg || 'Assertion failed');
    }
    function inherits(ctor, superCtor) {
      ctor.super_ = superCtor;
      var TempCtor = function() {};
      TempCtor.prototype = superCtor.prototype;
      ctor.prototype = new TempCtor();
      ctor.prototype.constructor = ctor;
    }
    function BN(number, base, endian) {
      if (number !== null && typeof number === 'object' && Array.isArray(number.words)) {
        return number;
      }
      this.sign = false;
      this.words = null;
      this.length = 0;
      this.red = null;
      if (base === 'le' || base === 'be') {
        endian = base;
        base = 10;
      }
      if (number !== null)
        this._init(number || 0, base || 10, endian || 'be');
    }
    if (typeof module === 'object')
      module.exports = BN;
    else
      exports.BN = BN;
    BN.BN = BN;
    BN.wordSize = 26;
    BN.prototype._init = function init(number, base, endian) {
      if (typeof number === 'number') {
        if (number < 0) {
          this.sign = true;
          number = -number;
        }
        if (number < 0x4000000) {
          this.words = [number & 0x3ffffff];
          this.length = 1;
        } else {
          this.words = [number & 0x3ffffff, (number / 0x4000000) & 0x3ffffff];
          this.length = 2;
        }
        return ;
      } else if (typeof number === 'object') {
        return this._initArray(number, base, endian);
      }
      if (base === 'hex')
        base = 16;
      assert(base === (base | 0) && base >= 2 && base <= 36);
      number = number.toString().replace(/\s+/g, '');
      var start = 0;
      if (number[0] === '-')
        start++;
      if (base === 16)
        this._parseHex(number, start);
      else
        this._parseBase(number, base, start);
      if (number[0] === '-')
        this.sign = true;
      this.strip();
    };
    BN.prototype._initArray = function _initArray(number, base, endian) {
      assert(typeof number.length === 'number');
      this.length = Math.ceil(number.length / 3);
      this.words = new Array(this.length);
      for (var i = 0; i < this.length; i++)
        this.words[i] = 0;
      var off = 0;
      if (endian === 'be') {
        for (var i = number.length - 1,
            j = 0; i >= 0; i -= 3) {
          var w = number[i] | (number[i - 1] << 8) | (number[i - 2] << 16);
          this.words[j] |= (w << off) & 0x3ffffff;
          this.words[j + 1] = (w >>> (26 - off)) & 0x3ffffff;
          off += 24;
          if (off >= 26) {
            off -= 26;
            j++;
          }
        }
      } else if (endian === 'le') {
        for (var i = 0,
            j = 0; i < number.length; i += 3) {
          var w = number[i] | (number[i + 1] << 8) | (number[i + 2] << 16);
          this.words[j] |= (w << off) & 0x3ffffff;
          this.words[j + 1] = (w >>> (26 - off)) & 0x3ffffff;
          off += 24;
          if (off >= 26) {
            off -= 26;
            j++;
          }
        }
      }
      return this.strip();
    };
    function parseHex(str, start, end) {
      var r = 0;
      var len = Math.min(str.length, end);
      for (var i = start; i < len; i++) {
        var c = str.charCodeAt(i) - 48;
        r <<= 4;
        if (c >= 49 && c <= 54)
          r |= c - 49 + 0xa;
        else if (c >= 17 && c <= 22)
          r |= c - 17 + 0xa;
        else
          r |= c & 0xf;
      }
      return r;
    }
    BN.prototype._parseHex = function _parseHex(number, start) {
      this.length = Math.ceil((number.length - start) / 6);
      this.words = new Array(this.length);
      for (var i = 0; i < this.length; i++)
        this.words[i] = 0;
      var off = 0;
      for (var i = number.length - 6,
          j = 0; i >= start; i -= 6) {
        var w = parseHex(number, i, i + 6);
        this.words[j] |= (w << off) & 0x3ffffff;
        this.words[j + 1] |= w >>> (26 - off) & 0x3fffff;
        off += 24;
        if (off >= 26) {
          off -= 26;
          j++;
        }
      }
      if (i + 6 !== start) {
        var w = parseHex(number, start, i + 6);
        this.words[j] |= (w << off) & 0x3ffffff;
        this.words[j + 1] |= w >>> (26 - off) & 0x3fffff;
      }
      this.strip();
    };
    function parseBase(str, start, end, mul) {
      var r = 0;
      var len = Math.min(str.length, end);
      for (var i = start; i < len; i++) {
        var c = str.charCodeAt(i) - 48;
        r *= mul;
        if (c >= 49)
          r += c - 49 + 0xa;
        else if (c >= 17)
          r += c - 17 + 0xa;
        else
          r += c;
      }
      return r;
    }
    BN.prototype._parseBase = function _parseBase(number, base, start) {
      this.words = [0];
      this.length = 1;
      for (var limbLen = 0,
          limbPow = 1; limbPow <= 0x3ffffff; limbPow *= base)
        limbLen++;
      limbLen--;
      limbPow = (limbPow / base) | 0;
      var total = number.length - start;
      var mod = total % limbLen;
      var end = Math.min(total, total - mod) + start;
      var word = 0;
      for (var i = start; i < end; i += limbLen) {
        word = parseBase(number, i, i + limbLen, base);
        this.imuln(limbPow);
        if (this.words[0] + word < 0x4000000)
          this.words[0] += word;
        else
          this._iaddn(word);
      }
      if (mod !== 0) {
        var pow = 1;
        var word = parseBase(number, i, number.length, base);
        for (var i = 0; i < mod; i++)
          pow *= base;
        this.imuln(pow);
        if (this.words[0] + word < 0x4000000)
          this.words[0] += word;
        else
          this._iaddn(word);
      }
    };
    BN.prototype.copy = function copy(dest) {
      dest.words = new Array(this.length);
      for (var i = 0; i < this.length; i++)
        dest.words[i] = this.words[i];
      dest.length = this.length;
      dest.sign = this.sign;
      dest.red = this.red;
    };
    BN.prototype.clone = function clone() {
      var r = new BN(null);
      this.copy(r);
      return r;
    };
    BN.prototype.strip = function strip() {
      while (this.length > 1 && this.words[this.length - 1] === 0)
        this.length--;
      return this._normSign();
    };
    BN.prototype._normSign = function _normSign() {
      if (this.length === 1 && this.words[0] === 0)
        this.sign = false;
      return this;
    };
    BN.prototype.inspect = function inspect() {
      return (this.red ? '<BN-R: ' : '<BN: ') + this.toString(16) + '>';
    };
    var zeros = ['', '0', '00', '000', '0000', '00000', '000000', '0000000', '00000000', '000000000', '0000000000', '00000000000', '000000000000', '0000000000000', '00000000000000', '000000000000000', '0000000000000000', '00000000000000000', '000000000000000000', '0000000000000000000', '00000000000000000000', '000000000000000000000', '0000000000000000000000', '00000000000000000000000', '000000000000000000000000', '0000000000000000000000000'];
    var groupSizes = [0, 0, 25, 16, 12, 11, 10, 9, 8, 8, 7, 7, 7, 7, 6, 6, 6, 6, 6, 6, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    var groupBases = [0, 0, 33554432, 43046721, 16777216, 48828125, 60466176, 40353607, 16777216, 43046721, 10000000, 19487171, 35831808, 62748517, 7529536, 11390625, 16777216, 24137569, 34012224, 47045881, 64000000, 4084101, 5153632, 6436343, 7962624, 9765625, 11881376, 14348907, 17210368, 20511149, 24300000, 28629151, 33554432, 39135393, 45435424, 52521875, 60466176];
    BN.prototype.toString = function toString(base, padding) {
      base = base || 10;
      if (base === 16 || base === 'hex') {
        var out = '';
        var off = 0;
        var padding = padding | 0 || 1;
        var carry = 0;
        for (var i = 0; i < this.length; i++) {
          var w = this.words[i];
          var word = (((w << off) | carry) & 0xffffff).toString(16);
          carry = (w >>> (24 - off)) & 0xffffff;
          if (carry !== 0 || i !== this.length - 1)
            out = zeros[6 - word.length] + word + out;
          else
            out = word + out;
          off += 2;
          if (off >= 26) {
            off -= 26;
            i--;
          }
        }
        if (carry !== 0)
          out = carry.toString(16) + out;
        while (out.length % padding !== 0)
          out = '0' + out;
        if (this.sign)
          out = '-' + out;
        return out;
      } else if (base === (base | 0) && base >= 2 && base <= 36) {
        var groupSize = groupSizes[base];
        var groupBase = groupBases[base];
        var out = '';
        var c = this.clone();
        c.sign = false;
        while (c.cmpn(0) !== 0) {
          var r = c.modn(groupBase).toString(base);
          c = c.idivn(groupBase);
          if (c.cmpn(0) !== 0)
            out = zeros[groupSize - r.length] + r + out;
          else
            out = r + out;
        }
        if (this.cmpn(0) === 0)
          out = '0' + out;
        if (this.sign)
          out = '-' + out;
        return out;
      } else {
        assert(false, 'Base should be between 2 and 36');
      }
    };
    BN.prototype.toJSON = function toJSON() {
      return this.toString(16);
    };
    BN.prototype.toArray = function toArray() {
      this.strip();
      var res = new Array(this.byteLength());
      res[0] = 0;
      var q = this.clone();
      for (var i = 0; q.cmpn(0) !== 0; i++) {
        var b = q.andln(0xff);
        q.ishrn(8);
        res[res.length - i - 1] = b;
      }
      return res;
    };
    BN.prototype._countBits = function _countBits(w) {
      return w >= 0x2000000 ? 26 : w >= 0x1000000 ? 25 : w >= 0x800000 ? 24 : w >= 0x400000 ? 23 : w >= 0x200000 ? 22 : w >= 0x100000 ? 21 : w >= 0x80000 ? 20 : w >= 0x40000 ? 19 : w >= 0x20000 ? 18 : w >= 0x10000 ? 17 : w >= 0x8000 ? 16 : w >= 0x4000 ? 15 : w >= 0x2000 ? 14 : w >= 0x1000 ? 13 : w >= 0x800 ? 12 : w >= 0x400 ? 11 : w >= 0x200 ? 10 : w >= 0x100 ? 9 : w >= 0x80 ? 8 : w >= 0x40 ? 7 : w >= 0x20 ? 6 : w >= 0x10 ? 5 : w >= 0x8 ? 4 : w >= 0x4 ? 3 : w >= 0x2 ? 2 : w >= 0x1 ? 1 : 0;
    };
    BN.prototype.bitLength = function bitLength() {
      var hi = 0;
      var w = this.words[this.length - 1];
      var hi = this._countBits(w);
      return (this.length - 1) * 26 + hi;
    };
    BN.prototype.byteLength = function byteLength() {
      return Math.ceil(this.bitLength() / 8);
    };
    BN.prototype.neg = function neg() {
      if (this.cmpn(0) === 0)
        return this.clone();
      var r = this.clone();
      r.sign = !this.sign;
      return r;
    };
    BN.prototype.ior = function ior(num) {
      this.sign = this.sign || num.sign;
      while (this.length < num.length)
        this.words[this.length++] = 0;
      for (var i = 0; i < num.length; i++)
        this.words[i] = this.words[i] | num.words[i];
      return this.strip();
    };
    BN.prototype.or = function or(num) {
      if (this.length > num.length)
        return this.clone().ior(num);
      else
        return num.clone().ior(this);
    };
    BN.prototype.iand = function iand(num) {
      this.sign = this.sign && num.sign;
      var b;
      if (this.length > num.length)
        b = num;
      else
        b = this;
      for (var i = 0; i < b.length; i++)
        this.words[i] = this.words[i] & num.words[i];
      this.length = b.length;
      return this.strip();
    };
    BN.prototype.and = function and(num) {
      if (this.length > num.length)
        return this.clone().iand(num);
      else
        return num.clone().iand(this);
    };
    BN.prototype.ixor = function ixor(num) {
      this.sign = this.sign || num.sign;
      var a;
      var b;
      if (this.length > num.length) {
        a = this;
        b = num;
      } else {
        a = num;
        b = this;
      }
      for (var i = 0; i < b.length; i++)
        this.words[i] = a.words[i] ^ b.words[i];
      if (this !== a)
        for (; i < a.length; i++)
          this.words[i] = a.words[i];
      this.length = a.length;
      return this.strip();
    };
    BN.prototype.xor = function xor(num) {
      if (this.length > num.length)
        return this.clone().ixor(num);
      else
        return num.clone().ixor(this);
    };
    BN.prototype.setn = function setn(bit, val) {
      assert(typeof bit === 'number' && bit >= 0);
      var off = (bit / 26) | 0;
      var wbit = bit % 26;
      while (this.length <= off)
        this.words[this.length++] = 0;
      if (val)
        this.words[off] = this.words[off] | (1 << wbit);
      else
        this.words[off] = this.words[off] & ~(1 << wbit);
      return this.strip();
    };
    BN.prototype.iadd = function iadd(num) {
      if (this.sign && !num.sign) {
        this.sign = false;
        var r = this.isub(num);
        this.sign = !this.sign;
        return this._normSign();
      } else if (!this.sign && num.sign) {
        num.sign = false;
        var r = this.isub(num);
        num.sign = true;
        return r._normSign();
      }
      var a;
      var b;
      if (this.length > num.length) {
        a = this;
        b = num;
      } else {
        a = num;
        b = this;
      }
      var carry = 0;
      for (var i = 0; i < b.length; i++) {
        var r = a.words[i] + b.words[i] + carry;
        this.words[i] = r & 0x3ffffff;
        carry = r >>> 26;
      }
      for (; carry !== 0 && i < a.length; i++) {
        var r = a.words[i] + carry;
        this.words[i] = r & 0x3ffffff;
        carry = r >>> 26;
      }
      this.length = a.length;
      if (carry !== 0) {
        this.words[this.length] = carry;
        this.length++;
      } else if (a !== this) {
        for (; i < a.length; i++)
          this.words[i] = a.words[i];
      }
      return this;
    };
    BN.prototype.add = function add(num) {
      if (num.sign && !this.sign) {
        num.sign = false;
        var res = this.sub(num);
        num.sign = true;
        return res;
      } else if (!num.sign && this.sign) {
        this.sign = false;
        var res = num.sub(this);
        this.sign = true;
        return res;
      }
      if (this.length > num.length)
        return this.clone().iadd(num);
      else
        return num.clone().iadd(this);
    };
    BN.prototype.isub = function isub(num) {
      if (num.sign) {
        num.sign = false;
        var r = this.iadd(num);
        num.sign = true;
        return r._normSign();
      } else if (this.sign) {
        this.sign = false;
        this.iadd(num);
        this.sign = true;
        return this._normSign();
      }
      var cmp = this.cmp(num);
      if (cmp === 0) {
        this.sign = false;
        this.length = 1;
        this.words[0] = 0;
        return this;
      }
      var a;
      var b;
      if (cmp > 0) {
        a = this;
        b = num;
      } else {
        a = num;
        b = this;
      }
      var carry = 0;
      for (var i = 0; i < b.length; i++) {
        var r = a.words[i] - b.words[i] + carry;
        carry = r >> 26;
        this.words[i] = r & 0x3ffffff;
      }
      for (; carry !== 0 && i < a.length; i++) {
        var r = a.words[i] + carry;
        carry = r >> 26;
        this.words[i] = r & 0x3ffffff;
      }
      if (carry === 0 && i < a.length && a !== this)
        for (; i < a.length; i++)
          this.words[i] = a.words[i];
      this.length = Math.max(this.length, i);
      if (a !== this)
        this.sign = true;
      return this.strip();
    };
    BN.prototype.sub = function sub(num) {
      return this.clone().isub(num);
    };
    BN.prototype._smallMulTo = function _smallMulTo(num, out) {
      out.sign = num.sign !== this.sign;
      out.length = this.length + num.length;
      var carry = 0;
      for (var k = 0; k < out.length - 1; k++) {
        var ncarry = carry >>> 26;
        var rword = carry & 0x3ffffff;
        var maxJ = Math.min(k, num.length - 1);
        for (var j = Math.max(0, k - this.length + 1); j <= maxJ; j++) {
          var i = k - j;
          var a = this.words[i] | 0;
          var b = num.words[j] | 0;
          var r = a * b;
          var lo = r & 0x3ffffff;
          ncarry = (ncarry + ((r / 0x4000000) | 0)) | 0;
          lo = (lo + rword) | 0;
          rword = lo & 0x3ffffff;
          ncarry = (ncarry + (lo >>> 26)) | 0;
        }
        out.words[k] = rword;
        carry = ncarry;
      }
      if (carry !== 0) {
        out.words[k] = carry;
      } else {
        out.length--;
      }
      return out.strip();
    };
    BN.prototype._bigMulTo = function _bigMulTo(num, out) {
      out.sign = num.sign !== this.sign;
      out.length = this.length + num.length;
      var carry = 0;
      var hncarry = 0;
      for (var k = 0; k < out.length - 1; k++) {
        var ncarry = hncarry;
        hncarry = 0;
        var rword = carry & 0x3ffffff;
        var maxJ = Math.min(k, num.length - 1);
        for (var j = Math.max(0, k - this.length + 1); j <= maxJ; j++) {
          var i = k - j;
          var a = this.words[i] | 0;
          var b = num.words[j] | 0;
          var r = a * b;
          var lo = r & 0x3ffffff;
          ncarry = (ncarry + ((r / 0x4000000) | 0)) | 0;
          lo = (lo + rword) | 0;
          rword = lo & 0x3ffffff;
          ncarry = (ncarry + (lo >>> 26)) | 0;
          hncarry += ncarry >>> 26;
          ncarry &= 0x3ffffff;
        }
        out.words[k] = rword;
        carry = ncarry;
        ncarry = hncarry;
      }
      if (carry !== 0) {
        out.words[k] = carry;
      } else {
        out.length--;
      }
      return out.strip();
    };
    BN.prototype.mulTo = function mulTo(num, out) {
      var res;
      if (this.length + num.length < 63)
        res = this._smallMulTo(num, out);
      else
        res = this._bigMulTo(num, out);
      return res;
    };
    BN.prototype.mul = function mul(num) {
      var out = new BN(null);
      out.words = new Array(this.length + num.length);
      return this.mulTo(num, out);
    };
    BN.prototype.imul = function imul(num) {
      if (this.cmpn(0) === 0 || num.cmpn(0) === 0) {
        this.words[0] = 0;
        this.length = 1;
        return this;
      }
      var tlen = this.length;
      var nlen = num.length;
      this.sign = num.sign !== this.sign;
      this.length = this.length + num.length;
      this.words[this.length - 1] = 0;
      for (var k = this.length - 2; k >= 0; k--) {
        var carry = 0;
        var rword = 0;
        var maxJ = Math.min(k, nlen - 1);
        for (var j = Math.max(0, k - tlen + 1); j <= maxJ; j++) {
          var i = k - j;
          var a = this.words[i];
          var b = num.words[j];
          var r = a * b;
          var lo = r & 0x3ffffff;
          carry += (r / 0x4000000) | 0;
          lo += rword;
          rword = lo & 0x3ffffff;
          carry += lo >>> 26;
        }
        this.words[k] = rword;
        this.words[k + 1] += carry;
        carry = 0;
      }
      var carry = 0;
      for (var i = 1; i < this.length; i++) {
        var w = this.words[i] + carry;
        this.words[i] = w & 0x3ffffff;
        carry = w >>> 26;
      }
      return this.strip();
    };
    BN.prototype.imuln = function imuln(num) {
      assert(typeof num === 'number');
      var carry = 0;
      for (var i = 0; i < this.length; i++) {
        var w = this.words[i] * num;
        var lo = (w & 0x3ffffff) + (carry & 0x3ffffff);
        carry >>= 26;
        carry += (w / 0x4000000) | 0;
        carry += lo >>> 26;
        this.words[i] = lo & 0x3ffffff;
      }
      if (carry !== 0) {
        this.words[i] = carry;
        this.length++;
      }
      return this;
    };
    BN.prototype.sqr = function sqr() {
      return this.mul(this);
    };
    BN.prototype.isqr = function isqr() {
      return this.mul(this);
    };
    BN.prototype.ishln = function ishln(bits) {
      assert(typeof bits === 'number' && bits >= 0);
      var r = bits % 26;
      var s = (bits - r) / 26;
      var carryMask = (0x3ffffff >>> (26 - r)) << (26 - r);
      if (r !== 0) {
        var carry = 0;
        for (var i = 0; i < this.length; i++) {
          var newCarry = this.words[i] & carryMask;
          var c = (this.words[i] - newCarry) << r;
          this.words[i] = c | carry;
          carry = newCarry >>> (26 - r);
        }
        if (carry) {
          this.words[i] = carry;
          this.length++;
        }
      }
      if (s !== 0) {
        for (var i = this.length - 1; i >= 0; i--)
          this.words[i + s] = this.words[i];
        for (var i = 0; i < s; i++)
          this.words[i] = 0;
        this.length += s;
      }
      return this.strip();
    };
    BN.prototype.ishrn = function ishrn(bits, hint, extended) {
      assert(typeof bits === 'number' && bits >= 0);
      if (hint)
        hint = (hint - (hint % 26)) / 26;
      else
        hint = 0;
      var r = bits % 26;
      var s = Math.min((bits - r) / 26, this.length);
      var mask = 0x3ffffff ^ ((0x3ffffff >>> r) << r);
      var maskedWords = extended;
      hint -= s;
      hint = Math.max(0, hint);
      if (maskedWords) {
        for (var i = 0; i < s; i++)
          maskedWords.words[i] = this.words[i];
        maskedWords.length = s;
      }
      if (s === 0) {} else if (this.length > s) {
        this.length -= s;
        for (var i = 0; i < this.length; i++)
          this.words[i] = this.words[i + s];
      } else {
        this.words[0] = 0;
        this.length = 1;
      }
      var carry = 0;
      for (var i = this.length - 1; i >= 0 && (carry !== 0 || i >= hint); i--) {
        var word = this.words[i];
        this.words[i] = (carry << (26 - r)) | (word >>> r);
        carry = word & mask;
      }
      if (maskedWords && carry !== 0)
        maskedWords.words[maskedWords.length++] = carry;
      if (this.length === 0) {
        this.words[0] = 0;
        this.length = 1;
      }
      this.strip();
      if (extended)
        return {
          hi: this,
          lo: maskedWords
        };
      return this;
    };
    BN.prototype.shln = function shln(bits) {
      return this.clone().ishln(bits);
    };
    BN.prototype.shrn = function shrn(bits) {
      return this.clone().ishrn(bits);
    };
    BN.prototype.testn = function testn(bit) {
      assert(typeof bit === 'number' && bit >= 0);
      var r = bit % 26;
      var s = (bit - r) / 26;
      var q = 1 << r;
      if (this.length <= s) {
        return false;
      }
      var w = this.words[s];
      return !!(w & q);
    };
    BN.prototype.imaskn = function imaskn(bits) {
      assert(typeof bits === 'number' && bits >= 0);
      var r = bits % 26;
      var s = (bits - r) / 26;
      assert(!this.sign, 'imaskn works only with positive numbers');
      if (r !== 0)
        s++;
      this.length = Math.min(s, this.length);
      if (r !== 0) {
        var mask = 0x3ffffff ^ ((0x3ffffff >>> r) << r);
        this.words[this.length - 1] &= mask;
      }
      return this.strip();
    };
    BN.prototype.maskn = function maskn(bits) {
      return this.clone().imaskn(bits);
    };
    BN.prototype.iaddn = function iaddn(num) {
      assert(typeof num === 'number');
      if (num < 0)
        return this.isubn(-num);
      if (this.sign) {
        if (this.length === 1 && this.words[0] < num) {
          this.words[0] = num - this.words[0];
          this.sign = false;
          return this;
        }
        this.sign = false;
        this.isubn(num);
        this.sign = true;
        return this;
      }
      return this._iaddn(num);
    };
    BN.prototype._iaddn = function _iaddn(num) {
      this.words[0] += num;
      for (var i = 0; i < this.length && this.words[i] >= 0x4000000; i++) {
        this.words[i] -= 0x4000000;
        if (i === this.length - 1)
          this.words[i + 1] = 1;
        else
          this.words[i + 1]++;
      }
      this.length = Math.max(this.length, i + 1);
      return this;
    };
    BN.prototype.isubn = function isubn(num) {
      assert(typeof num === 'number');
      if (num < 0)
        return this.iaddn(-num);
      if (this.sign) {
        this.sign = false;
        this.iaddn(num);
        this.sign = true;
        return this;
      }
      this.words[0] -= num;
      for (var i = 0; i < this.length && this.words[i] < 0; i++) {
        this.words[i] += 0x4000000;
        this.words[i + 1] -= 1;
      }
      return this.strip();
    };
    BN.prototype.addn = function addn(num) {
      return this.clone().iaddn(num);
    };
    BN.prototype.subn = function subn(num) {
      return this.clone().isubn(num);
    };
    BN.prototype.iabs = function iabs() {
      this.sign = false;
      return this;
    };
    BN.prototype.abs = function abs() {
      return this.clone().iabs();
    };
    BN.prototype._ishlnsubmul = function _ishlnsubmul(num, mul, shift) {
      var len = num.length + shift;
      var i;
      if (this.words.length < len) {
        var t = new Array(len);
        for (var i = 0; i < this.length; i++)
          t[i] = this.words[i];
        this.words = t;
      } else {
        i = this.length;
      }
      this.length = Math.max(this.length, len);
      for (; i < this.length; i++)
        this.words[i] = 0;
      var carry = 0;
      for (var i = 0; i < num.length; i++) {
        var w = this.words[i + shift] + carry;
        var right = num.words[i] * mul;
        w -= right & 0x3ffffff;
        carry = (w >> 26) - ((right / 0x4000000) | 0);
        this.words[i + shift] = w & 0x3ffffff;
      }
      for (; i < this.length - shift; i++) {
        var w = this.words[i + shift] + carry;
        carry = w >> 26;
        this.words[i + shift] = w & 0x3ffffff;
      }
      if (carry === 0)
        return this.strip();
      assert(carry === -1);
      carry = 0;
      for (var i = 0; i < this.length; i++) {
        var w = -this.words[i] + carry;
        carry = w >> 26;
        this.words[i] = w & 0x3ffffff;
      }
      this.sign = true;
      return this.strip();
    };
    BN.prototype._wordDiv = function _wordDiv(num, mode) {
      var shift = this.length - num.length;
      var a = this.clone();
      var b = num;
      var bhi = b.words[b.length - 1];
      for (var shift = 0; bhi < 0x2000000; shift++)
        bhi <<= 1;
      if (shift !== 0) {
        b = b.shln(shift);
        a.ishln(shift);
        bhi = b.words[b.length - 1];
      }
      var m = a.length - b.length;
      var q;
      if (mode !== 'mod') {
        q = new BN(null);
        q.length = m + 1;
        q.words = new Array(q.length);
        for (var i = 0; i < q.length; i++)
          q.words[i] = 0;
      }
      var diff = a.clone()._ishlnsubmul(b, 1, m);
      if (!diff.sign) {
        a = diff;
        if (q)
          q.words[m] = 1;
      }
      for (var j = m - 1; j >= 0; j--) {
        var qj = a.words[b.length + j] * 0x4000000 + a.words[b.length + j - 1];
        qj = Math.min((qj / bhi) | 0, 0x3ffffff);
        a._ishlnsubmul(b, qj, j);
        while (a.sign) {
          qj--;
          a.sign = false;
          a._ishlnsubmul(b, 1, j);
          a.sign = !a.sign;
        }
        if (q)
          q.words[j] = qj;
      }
      if (q)
        q.strip();
      a.strip();
      if (mode !== 'div' && shift !== 0)
        a.ishrn(shift);
      return {
        div: q ? q : null,
        mod: a
      };
    };
    BN.prototype.divmod = function divmod(num, mode) {
      assert(num.cmpn(0) !== 0);
      if (this.sign && !num.sign) {
        var res = this.neg().divmod(num, mode);
        var div;
        var mod;
        if (mode !== 'mod')
          div = res.div.neg();
        if (mode !== 'div')
          mod = res.mod.cmpn(0) === 0 ? res.mod : num.sub(res.mod);
        return {
          div: div,
          mod: mod
        };
      } else if (!this.sign && num.sign) {
        var res = this.divmod(num.neg(), mode);
        var div;
        if (mode !== 'mod')
          div = res.div.neg();
        return {
          div: div,
          mod: res.mod
        };
      } else if (this.sign && num.sign) {
        return this.neg().divmod(num.neg(), mode);
      }
      if (num.length > this.length || this.cmp(num) < 0)
        return {
          div: new BN(0),
          mod: this
        };
      if (num.length === 1) {
        if (mode === 'div')
          return {
            div: this.divn(num.words[0]),
            mod: null
          };
        else if (mode === 'mod')
          return {
            div: null,
            mod: new BN(this.modn(num.words[0]))
          };
        return {
          div: this.divn(num.words[0]),
          mod: new BN(this.modn(num.words[0]))
        };
      }
      return this._wordDiv(num, mode);
    };
    BN.prototype.div = function div(num) {
      return this.divmod(num, 'div').div;
    };
    BN.prototype.mod = function mod(num) {
      return this.divmod(num, 'mod').mod;
    };
    BN.prototype.divRound = function divRound(num) {
      var dm = this.divmod(num);
      if (dm.mod.cmpn(0) === 0)
        return dm.div;
      var mod = dm.div.sign ? dm.mod.isub(num) : dm.mod;
      var half = num.shrn(1);
      var r2 = num.andln(1);
      var cmp = mod.cmp(half);
      if (cmp < 0 || r2 === 1 && cmp === 0)
        return dm.div;
      return dm.div.sign ? dm.div.isubn(1) : dm.div.iaddn(1);
    };
    BN.prototype.modn = function modn(num) {
      assert(num <= 0x3ffffff);
      var p = (1 << 26) % num;
      var acc = 0;
      for (var i = this.length - 1; i >= 0; i--)
        acc = (p * acc + this.words[i]) % num;
      return acc;
    };
    BN.prototype.idivn = function idivn(num) {
      assert(num <= 0x3ffffff);
      var carry = 0;
      for (var i = this.length - 1; i >= 0; i--) {
        var w = this.words[i] + carry * 0x4000000;
        this.words[i] = (w / num) | 0;
        carry = w % num;
      }
      return this.strip();
    };
    BN.prototype.divn = function divn(num) {
      return this.clone().idivn(num);
    };
    BN.prototype._egcd = function _egcd(x1, p) {
      assert(!p.sign);
      assert(p.cmpn(0) !== 0);
      var a = this;
      var b = p.clone();
      if (a.sign)
        a = a.mod(p);
      else
        a = a.clone();
      var x2 = new BN(0);
      while (b.isEven())
        b.ishrn(1);
      var delta = b.clone();
      while (a.cmpn(1) > 0 && b.cmpn(1) > 0) {
        while (a.isEven()) {
          a.ishrn(1);
          if (x1.isEven())
            x1.ishrn(1);
          else
            x1.iadd(delta).ishrn(1);
        }
        while (b.isEven()) {
          b.ishrn(1);
          if (x2.isEven())
            x2.ishrn(1);
          else
            x2.iadd(delta).ishrn(1);
        }
        if (a.cmp(b) >= 0) {
          a.isub(b);
          x1.isub(x2);
        } else {
          b.isub(a);
          x2.isub(x1);
        }
      }
      if (a.cmpn(1) === 0)
        return x1;
      else
        return x2;
    };
    BN.prototype.gcd = function gcd(num) {
      if (this.cmpn(0) === 0)
        return num.clone();
      if (num.cmpn(0) === 0)
        return this.clone();
      var a = this.clone();
      var b = num.clone();
      a.sign = false;
      b.sign = false;
      for (var shift = 0; a.isEven() && b.isEven(); shift++) {
        a.ishrn(1);
        b.ishrn(1);
      }
      while (a.isEven())
        a.ishrn(1);
      do {
        while (b.isEven())
          b.ishrn(1);
        if (a.cmp(b) < 0) {
          var t = a;
          a = b;
          b = t;
        }
        a.isub(a.div(b).mul(b));
      } while (a.cmpn(0) !== 0 && b.cmpn(0) !== 0);
      if (a.cmpn(0) === 0)
        return b.ishln(shift);
      else
        return a.ishln(shift);
    };
    BN.prototype.invm = function invm(num) {
      return this._egcd(new BN(1), num).mod(num);
    };
    BN.prototype.isEven = function isEven() {
      return (this.words[0] & 1) === 0;
    };
    BN.prototype.isOdd = function isOdd() {
      return (this.words[0] & 1) === 1;
    };
    BN.prototype.andln = function andln(num) {
      return this.words[0] & num;
    };
    BN.prototype.bincn = function bincn(bit) {
      assert(typeof bit === 'number');
      var r = bit % 26;
      var s = (bit - r) / 26;
      var q = 1 << r;
      if (this.length <= s) {
        for (var i = this.length; i < s + 1; i++)
          this.words[i] = 0;
        this.words[s] |= q;
        this.length = s + 1;
        return this;
      }
      var carry = q;
      for (var i = s; carry !== 0 && i < this.length; i++) {
        var w = this.words[i];
        w += carry;
        carry = w >>> 26;
        w &= 0x3ffffff;
        this.words[i] = w;
      }
      if (carry !== 0) {
        this.words[i] = carry;
        this.length++;
      }
      return this;
    };
    BN.prototype.cmpn = function cmpn(num) {
      var sign = num < 0;
      if (sign)
        num = -num;
      if (this.sign && !sign)
        return -1;
      else if (!this.sign && sign)
        return 1;
      num &= 0x3ffffff;
      this.strip();
      var res;
      if (this.length > 1) {
        res = 1;
      } else {
        var w = this.words[0];
        res = w === num ? 0 : w < num ? -1 : 1;
      }
      if (this.sign)
        res = -res;
      return res;
    };
    BN.prototype.cmp = function cmp(num) {
      if (this.sign && !num.sign)
        return -1;
      else if (!this.sign && num.sign)
        return 1;
      var res = this.ucmp(num);
      if (this.sign)
        return -res;
      else
        return res;
    };
    BN.prototype.ucmp = function ucmp(num) {
      if (this.length > num.length)
        return 1;
      else if (this.length < num.length)
        return -1;
      var res = 0;
      for (var i = this.length - 1; i >= 0; i--) {
        var a = this.words[i];
        var b = num.words[i];
        if (a === b)
          continue;
        if (a < b)
          res = -1;
        else if (a > b)
          res = 1;
        break;
      }
      return res;
    };
    BN.red = function red(num) {
      return new Red(num);
    };
    BN.prototype.toRed = function toRed(ctx) {
      assert(!this.red, 'Already a number in reduction context');
      assert(!this.sign, 'red works only with positives');
      return ctx.convertTo(this)._forceRed(ctx);
    };
    BN.prototype.fromRed = function fromRed() {
      assert(this.red, 'fromRed works only with numbers in reduction context');
      return this.red.convertFrom(this);
    };
    BN.prototype._forceRed = function _forceRed(ctx) {
      this.red = ctx;
      return this;
    };
    BN.prototype.forceRed = function forceRed(ctx) {
      assert(!this.red, 'Already a number in reduction context');
      return this._forceRed(ctx);
    };
    BN.prototype.redAdd = function redAdd(num) {
      assert(this.red, 'redAdd works only with red numbers');
      return this.red.add(this, num);
    };
    BN.prototype.redIAdd = function redIAdd(num) {
      assert(this.red, 'redIAdd works only with red numbers');
      return this.red.iadd(this, num);
    };
    BN.prototype.redSub = function redSub(num) {
      assert(this.red, 'redSub works only with red numbers');
      return this.red.sub(this, num);
    };
    BN.prototype.redISub = function redISub(num) {
      assert(this.red, 'redISub works only with red numbers');
      return this.red.isub(this, num);
    };
    BN.prototype.redShl = function redShl(num) {
      assert(this.red, 'redShl works only with red numbers');
      return this.red.shl(this, num);
    };
    BN.prototype.redMul = function redMul(num) {
      assert(this.red, 'redMul works only with red numbers');
      this.red._verify2(this, num);
      return this.red.mul(this, num);
    };
    BN.prototype.redIMul = function redIMul(num) {
      assert(this.red, 'redMul works only with red numbers');
      this.red._verify2(this, num);
      return this.red.imul(this, num);
    };
    BN.prototype.redSqr = function redSqr() {
      assert(this.red, 'redSqr works only with red numbers');
      this.red._verify1(this);
      return this.red.sqr(this);
    };
    BN.prototype.redISqr = function redISqr() {
      assert(this.red, 'redISqr works only with red numbers');
      this.red._verify1(this);
      return this.red.isqr(this);
    };
    BN.prototype.redSqrt = function redSqrt() {
      assert(this.red, 'redSqrt works only with red numbers');
      this.red._verify1(this);
      return this.red.sqrt(this);
    };
    BN.prototype.redInvm = function redInvm() {
      assert(this.red, 'redInvm works only with red numbers');
      this.red._verify1(this);
      return this.red.invm(this);
    };
    BN.prototype.redNeg = function redNeg() {
      assert(this.red, 'redNeg works only with red numbers');
      this.red._verify1(this);
      return this.red.neg(this);
    };
    BN.prototype.redPow = function redPow(num) {
      assert(this.red && !num.red, 'redPow(normalNum)');
      this.red._verify1(this);
      return this.red.pow(this, num);
    };
    var primes = {
      k256: null,
      p224: null,
      p192: null,
      p25519: null
    };
    function MPrime(name, p) {
      this.name = name;
      this.p = new BN(p, 16);
      this.n = this.p.bitLength();
      this.k = new BN(1).ishln(this.n).isub(this.p);
      this.tmp = this._tmp();
    }
    MPrime.prototype._tmp = function _tmp() {
      var tmp = new BN(null);
      tmp.words = new Array(Math.ceil(this.n / 13));
      return tmp;
    };
    MPrime.prototype.ireduce = function ireduce(num) {
      var r = num;
      var rlen;
      do {
        var pair = r.ishrn(this.n, 0, this.tmp);
        r = this.imulK(pair.hi);
        r = r.iadd(pair.lo);
        rlen = r.bitLength();
      } while (rlen > this.n);
      var cmp = rlen < this.n ? -1 : r.cmp(this.p);
      if (cmp === 0) {
        r.words[0] = 0;
        r.length = 1;
      } else if (cmp > 0) {
        r.isub(this.p);
      } else {
        r.strip();
      }
      return r;
    };
    MPrime.prototype.imulK = function imulK(num) {
      return num.imul(this.k);
    };
    function K256() {
      MPrime.call(this, 'k256', 'ffffffff ffffffff ffffffff ffffffff ffffffff ffffffff fffffffe fffffc2f');
    }
    inherits(K256, MPrime);
    K256.prototype.imulK = function imulK(num) {
      num.words[num.length] = 0;
      num.words[num.length + 1] = 0;
      num.length += 2;
      var hi;
      var lo = 0;
      for (var i = 0; i < num.length; i++) {
        var w = num.words[i];
        hi = w * 0x40;
        lo += w * 0x3d1;
        hi += (lo / 0x4000000) | 0;
        lo &= 0x3ffffff;
        num.words[i] = lo;
        lo = hi;
      }
      if (num.words[num.length - 1] === 0) {
        num.length--;
        if (num.words[num.length - 1] === 0)
          num.length--;
      }
      return num;
    };
    function P224() {
      MPrime.call(this, 'p224', 'ffffffff ffffffff ffffffff ffffffff 00000000 00000000 00000001');
    }
    inherits(P224, MPrime);
    function P192() {
      MPrime.call(this, 'p192', 'ffffffff ffffffff ffffffff fffffffe ffffffff ffffffff');
    }
    inherits(P192, MPrime);
    function P25519() {
      MPrime.call(this, '25519', '7fffffffffffffff ffffffffffffffff ffffffffffffffff ffffffffffffffed');
    }
    inherits(P25519, MPrime);
    P25519.prototype.imulK = function imulK(num) {
      var carry = 0;
      for (var i = 0; i < num.length; i++) {
        var hi = num.words[i] * 0x13 + carry;
        var lo = hi & 0x3ffffff;
        hi >>>= 26;
        num.words[i] = lo;
        carry = hi;
      }
      if (carry !== 0)
        num.words[num.length++] = carry;
      return num;
    };
    BN._prime = function prime(name) {
      if (primes[name])
        return primes[name];
      var prime;
      if (name === 'k256')
        prime = new K256();
      else if (name === 'p224')
        prime = new P224();
      else if (name === 'p192')
        prime = new P192();
      else if (name === 'p25519')
        prime = new P25519();
      else
        throw new Error('Unknown prime ' + name);
      primes[name] = prime;
      return prime;
    };
    function Red(m) {
      if (typeof m === 'string') {
        var prime = BN._prime(m);
        this.m = prime.p;
        this.prime = prime;
      } else {
        this.m = m;
        this.prime = null;
      }
    }
    Red.prototype._verify1 = function _verify1(a) {
      assert(!a.sign, 'red works only with positives');
      assert(a.red, 'red works only with red numbers');
    };
    Red.prototype._verify2 = function _verify2(a, b) {
      assert(!a.sign && !b.sign, 'red works only with positives');
      assert(a.red && a.red === b.red, 'red works only with red numbers');
    };
    Red.prototype.imod = function imod(a) {
      if (this.prime)
        return this.prime.ireduce(a)._forceRed(this);
      return a.mod(this.m)._forceRed(this);
    };
    Red.prototype.neg = function neg(a) {
      var r = a.clone();
      r.sign = !r.sign;
      return r.iadd(this.m)._forceRed(this);
    };
    Red.prototype.add = function add(a, b) {
      this._verify2(a, b);
      var res = a.add(b);
      if (res.cmp(this.m) >= 0)
        res.isub(this.m);
      return res._forceRed(this);
    };
    Red.prototype.iadd = function iadd(a, b) {
      this._verify2(a, b);
      var res = a.iadd(b);
      if (res.cmp(this.m) >= 0)
        res.isub(this.m);
      return res;
    };
    Red.prototype.sub = function sub(a, b) {
      this._verify2(a, b);
      var res = a.sub(b);
      if (res.cmpn(0) < 0)
        res.iadd(this.m);
      return res._forceRed(this);
    };
    Red.prototype.isub = function isub(a, b) {
      this._verify2(a, b);
      var res = a.isub(b);
      if (res.cmpn(0) < 0)
        res.iadd(this.m);
      return res;
    };
    Red.prototype.shl = function shl(a, num) {
      this._verify1(a);
      return this.imod(a.shln(num));
    };
    Red.prototype.imul = function imul(a, b) {
      this._verify2(a, b);
      return this.imod(a.imul(b));
    };
    Red.prototype.mul = function mul(a, b) {
      this._verify2(a, b);
      return this.imod(a.mul(b));
    };
    Red.prototype.isqr = function isqr(a) {
      return this.imul(a, a);
    };
    Red.prototype.sqr = function sqr(a) {
      return this.mul(a, a);
    };
    Red.prototype.sqrt = function sqrt(a) {
      if (a.cmpn(0) === 0)
        return a.clone();
      var mod3 = this.m.andln(3);
      assert(mod3 % 2 === 1);
      if (mod3 === 3) {
        var pow = this.m.add(new BN(1)).ishrn(2);
        var r = this.pow(a, pow);
        return r;
      }
      var q = this.m.subn(1);
      var s = 0;
      while (q.cmpn(0) !== 0 && q.andln(1) === 0) {
        s++;
        q.ishrn(1);
      }
      assert(q.cmpn(0) !== 0);
      var one = new BN(1).toRed(this);
      var nOne = one.redNeg();
      var lpow = this.m.subn(1).ishrn(1);
      var z = this.m.bitLength();
      z = new BN(2 * z * z).toRed(this);
      while (this.pow(z, lpow).cmp(nOne) !== 0)
        z.redIAdd(nOne);
      var c = this.pow(z, q);
      var r = this.pow(a, q.addn(1).ishrn(1));
      var t = this.pow(a, q);
      var m = s;
      while (t.cmp(one) !== 0) {
        var tmp = t;
        for (var i = 0; tmp.cmp(one) !== 0; i++)
          tmp = tmp.redSqr();
        assert(i < m);
        var b = this.pow(c, new BN(1).ishln(m - i - 1));
        r = r.redMul(b);
        c = b.redSqr();
        t = t.redMul(c);
        m = i;
      }
      return r;
    };
    Red.prototype.invm = function invm(a) {
      var inv = a._egcd(new BN(1), this.m);
      if (inv.sign) {
        inv.sign = false;
        return this.imod(inv).redNeg();
      } else {
        return this.imod(inv);
      }
    };
    Red.prototype.pow = function pow(a, num) {
      var w = [];
      var q = num.clone();
      while (q.cmpn(0) !== 0) {
        w.push(q.andln(1));
        q.ishrn(1);
      }
      var res = a;
      for (var i = 0; i < w.length; i++, res = this.sqr(res))
        if (w[i] !== 0)
          break;
      if (++i < w.length) {
        for (var q = this.sqr(res); i < w.length; i++, q = this.sqr(q)) {
          if (w[i] === 0)
            continue;
          res = this.mul(res, q);
        }
      }
      return res;
    };
    Red.prototype.convertTo = function convertTo(num) {
      return num.clone();
    };
    Red.prototype.convertFrom = function convertFrom(num) {
      var res = num.clone();
      res.red = null;
      return res;
    };
    BN.mont = function mont(num) {
      return new Mont(num);
    };
    function Mont(m) {
      Red.call(this, m);
      this.shift = this.m.bitLength();
      if (this.shift % 26 !== 0)
        this.shift += 26 - (this.shift % 26);
      this.r = new BN(1).ishln(this.shift);
      this.r2 = this.imod(this.r.sqr());
      this.rinv = this.r.invm(this.m);
      this.minv = this.rinv.mul(this.r).isubn(1).div(this.m);
      this.minv.sign = true;
      this.minv = this.minv.mod(this.r);
    }
    inherits(Mont, Red);
    Mont.prototype.convertTo = function convertTo(num) {
      return this.imod(num.shln(this.shift));
    };
    Mont.prototype.convertFrom = function convertFrom(num) {
      var r = this.imod(num.mul(this.rinv));
      r.red = null;
      return r;
    };
    Mont.prototype.imul = function imul(a, b) {
      if (a.cmpn(0) === 0 || b.cmpn(0) === 0) {
        a.words[0] = 0;
        a.length = 1;
        return a;
      }
      var t = a.imul(b);
      var c = t.maskn(this.shift).mul(this.minv).imaskn(this.shift).mul(this.m);
      var u = t.isub(c).ishrn(this.shift);
      var res = u;
      if (u.cmp(this.m) >= 0)
        res = u.isub(this.m);
      else if (u.cmpn(0) < 0)
        res = u.iadd(this.m);
      return res._forceRed(this);
    };
    Mont.prototype.mul = function mul(a, b) {
      if (a.cmpn(0) === 0 || b.cmpn(0) === 0)
        return new BN(0)._forceRed(this);
      var t = a.mul(b);
      var c = t.maskn(this.shift).mul(this.minv).imaskn(this.shift).mul(this.m);
      var u = t.isub(c).ishrn(this.shift);
      var res = u;
      if (u.cmp(this.m) >= 0)
        res = u.isub(this.m);
      else if (u.cmpn(0) < 0)
        res = u.iadd(this.m);
      return res._forceRed(this);
    };
    Mont.prototype.invm = function invm(a) {
      var res = this.imod(a.invm(this.m).mul(this.r2));
      return res._forceRed(this);
    };
  })(typeof module === 'undefined' || module, this);
  global.define = __define;
  return module.exports;
});

System.register("npm:brorand@1.0.5/index", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var r;
  module.exports = function rand(len) {
    if (!r)
      r = new Rand(null);
    return r.generate(len);
  };
  function Rand(rand) {
    this.rand = rand;
  }
  module.exports.Rand = Rand;
  Rand.prototype.generate = function generate(len) {
    return this._rand(len);
  };
  if (typeof window === 'object') {
    if (window.crypto && window.crypto.getRandomValues) {
      Rand.prototype._rand = function _rand(n) {
        var arr = new Uint8Array(n);
        window.crypto.getRandomValues(arr);
        return arr;
      };
    } else if (window.msCrypto && window.msCrypto.getRandomValues) {
      Rand.prototype._rand = function _rand(n) {
        var arr = new Uint8Array(n);
        window.msCrypto.getRandomValues(arr);
        return arr;
      };
    } else {
      Rand.prototype._rand = function() {
        throw new Error('Not implemented yet');
      };
    }
  } else {
    try {
      var crypto = require('cry' + 'pto');
      Rand.prototype._rand = function _rand(n) {
        return crypto.randomBytes(n);
      };
    } catch (e) {
      Rand.prototype._rand = function _rand(n) {
        var res = new Uint8Array(n);
        for (var i = 0; i < res.length; i++)
          res[i] = this.rand.getByte();
        return res;
      };
    }
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:diffie-hellman@3.0.1/lib/primes.json!github:systemjs/plugin-json@0.1.0", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "modp1": {
      "gen": "02",
      "prime": "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a63a3620ffffffffffffffff"
    },
    "modp2": {
      "gen": "02",
      "prime": "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece65381ffffffffffffffff"
    },
    "modp5": {
      "gen": "02",
      "prime": "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca237327ffffffffffffffff"
    },
    "modp14": {
      "gen": "02",
      "prime": "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aacaa68ffffffffffffffff"
    },
    "modp15": {
      "gen": "02",
      "prime": "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200cbbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a93ad2caffffffffffffffff"
    },
    "modp16": {
      "gen": "02",
      "prime": "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200cbbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a92108011a723c12a787e6d788719a10bdba5b2699c327186af4e23c1a946834b6150bda2583e9ca2ad44ce8dbbbc2db04de8ef92e8efc141fbecaa6287c59474e6bc05d99b2964fa090c3a2233ba186515be7ed1f612970cee2d7afb81bdd762170481cd0069127d5b05aa993b4ea988d8fddc186ffb7dc90a6c08f4df435c934063199ffffffffffffffff"
    },
    "modp17": {
      "gen": "02",
      "prime": "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200cbbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a92108011a723c12a787e6d788719a10bdba5b2699c327186af4e23c1a946834b6150bda2583e9ca2ad44ce8dbbbc2db04de8ef92e8efc141fbecaa6287c59474e6bc05d99b2964fa090c3a2233ba186515be7ed1f612970cee2d7afb81bdd762170481cd0069127d5b05aa993b4ea988d8fddc186ffb7dc90a6c08f4df435c93402849236c3fab4d27c7026c1d4dcb2602646dec9751e763dba37bdf8ff9406ad9e530ee5db382f413001aeb06a53ed9027d831179727b0865a8918da3edbebcf9b14ed44ce6cbaced4bb1bdb7f1447e6cc254b332051512bd7af426fb8f401378cd2bf5983ca01c64b92ecf032ea15d1721d03f482d7ce6e74fef6d55e702f46980c82b5a84031900b1c9e59e7c97fbec7e8f323a97a7e36cc88be0f1d45b7ff585ac54bd407b22b4154aacc8f6d7ebf48e1d814cc5ed20f8037e0a79715eef29be32806a1d58bb7c5da76f550aa3d8a1fbff0eb19ccb1a313d55cda56c9ec2ef29632387fe8d76e3c0468043e8f663f4860ee12bf2d5b0b7474d6e694f91e6dcc4024ffffffffffffffff"
    },
    "modp18": {
      "gen": "02",
      "prime": "ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f14374fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7edee386bfb5a899fa5ae9f24117c4b1fe649286651ece45b3dc2007cb8a163bf0598da48361c55d39a69163fa8fd24cf5f83655d23dca3ad961c62f356208552bb9ed529077096966d670c354e4abc9804f1746c08ca18217c32905e462e36ce3be39e772c180e86039b2783a2ec07a28fb5c55df06f4c52c9de2bcbf6955817183995497cea956ae515d2261898fa051015728e5a8aaac42dad33170d04507a33a85521abdf1cba64ecfb850458dbef0a8aea71575d060c7db3970f85a6e1e4c7abf5ae8cdb0933d71e8c94e04a25619dcee3d2261ad2ee6bf12ffa06d98a0864d87602733ec86a64521f2b18177b200cbbe117577a615d6c770988c0bad946e208e24fa074e5ab3143db5bfce0fd108e4b82d120a92108011a723c12a787e6d788719a10bdba5b2699c327186af4e23c1a946834b6150bda2583e9ca2ad44ce8dbbbc2db04de8ef92e8efc141fbecaa6287c59474e6bc05d99b2964fa090c3a2233ba186515be7ed1f612970cee2d7afb81bdd762170481cd0069127d5b05aa993b4ea988d8fddc186ffb7dc90a6c08f4df435c93402849236c3fab4d27c7026c1d4dcb2602646dec9751e763dba37bdf8ff9406ad9e530ee5db382f413001aeb06a53ed9027d831179727b0865a8918da3edbebcf9b14ed44ce6cbaced4bb1bdb7f1447e6cc254b332051512bd7af426fb8f401378cd2bf5983ca01c64b92ecf032ea15d1721d03f482d7ce6e74fef6d55e702f46980c82b5a84031900b1c9e59e7c97fbec7e8f323a97a7e36cc88be0f1d45b7ff585ac54bd407b22b4154aacc8f6d7ebf48e1d814cc5ed20f8037e0a79715eef29be32806a1d58bb7c5da76f550aa3d8a1fbff0eb19ccb1a313d55cda56c9ec2ef29632387fe8d76e3c0468043e8f663f4860ee12bf2d5b0b7474d6e694f91e6dbe115974a3926f12fee5e438777cb6a932df8cd8bec4d073b931ba3bc832b68d9dd300741fa7bf8afc47ed2576f6936ba424663aab639c5ae4f5683423b4742bf1c978238f16cbe39d652de3fdb8befc848ad922222e04a4037c0713eb57a81a23f0c73473fc646cea306b4bcbc8862f8385ddfa9d4b7fa2c087e879683303ed5bdd3a062b3cf5b3a278a66d2a13f83f44f82ddf310ee074ab6a364597e899a0255dc164f31cc50846851df9ab48195ded7ea1b1d510bd7ee74d73faf36bc31ecfa268359046f4eb879f924009438b481c6cd7889a002ed5ee382bc9190da6fc026e479558e4475677e9aa9e3050e2765694dfc81f56e880b96e7160c980dd98edd3dfffffffffffffffff"
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:diffie-hellman@3.0.1/lib/dh", ["npm:bn.js@1.3.0", "npm:miller-rabin@1.1.5", "npm:diffie-hellman@3.0.1/lib/generatePrime", "npm:randombytes@2.0.1", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var BN = require("npm:bn.js@1.3.0");
    var MillerRabin = require("npm:miller-rabin@1.1.5");
    var millerRabin = new MillerRabin();
    var TWENTYFOUR = new BN(24);
    var ELEVEN = new BN(11);
    var TEN = new BN(10);
    var THREE = new BN(3);
    var SEVEN = new BN(7);
    var primes = require("npm:diffie-hellman@3.0.1/lib/generatePrime");
    var randomBytes = require("npm:randombytes@2.0.1");
    module.exports = DH;
    function setPublicKey(pub, enc) {
      enc = enc || 'utf8';
      if (!Buffer.isBuffer(pub)) {
        pub = new Buffer(pub, enc);
      }
      this._pub = new BN(pub);
      return this;
    }
    function setPrivateKey(priv, enc) {
      enc = enc || 'utf8';
      if (!Buffer.isBuffer(priv)) {
        priv = new Buffer(priv, enc);
      }
      this._priv = new BN(priv);
      return this;
    }
    var primeCache = {};
    function checkPrime(prime, generator) {
      var gen = generator.toString('hex');
      var hex = [gen, prime.toString(16)].join('_');
      if (hex in primeCache) {
        return primeCache[hex];
      }
      var error = 0;
      if (prime.isEven() || !primes.simpleSieve || !primes.fermatTest(prime) || !millerRabin.test(prime)) {
        error += 1;
        if (gen === '02' || gen === '05') {
          error += 8;
        } else {
          error += 4;
        }
        primeCache[hex] = error;
        return error;
      }
      if (!millerRabin.test(prime.shrn(1))) {
        error += 2;
      }
      var rem;
      switch (gen) {
        case '02':
          if (prime.mod(TWENTYFOUR).cmp(ELEVEN)) {
            error += 8;
          }
          break;
        case '05':
          rem = prime.mod(TEN);
          if (rem.cmp(THREE) && rem.cmp(SEVEN)) {
            error += 8;
          }
          break;
        default:
          error += 4;
      }
      primeCache[hex] = error;
      return error;
    }
    function defineError(self, error) {
      try {
        Object.defineProperty(self, 'verifyError', {
          enumerable: true,
          value: error,
          writable: false
        });
      } catch (e) {
        self.verifyError = error;
      }
    }
    function DH(prime, generator, malleable) {
      this.setGenerator(generator);
      this.__prime = new BN(prime);
      this._prime = BN.mont(this.__prime);
      this._primeLen = prime.length;
      this._pub = void 0;
      this._priv = void 0;
      if (malleable) {
        this.setPublicKey = setPublicKey;
        this.setPrivateKey = setPrivateKey;
        defineError(this, checkPrime(this.__prime, generator));
      } else {
        defineError(this, 8);
      }
    }
    DH.prototype.generateKeys = function() {
      if (!this._priv) {
        this._priv = new BN(randomBytes(this._primeLen));
      }
      this._pub = this._gen.toRed(this._prime).redPow(this._priv).fromRed();
      return this.getPublicKey();
    };
    DH.prototype.computeSecret = function(other) {
      other = new BN(other);
      other = other.toRed(this._prime);
      var secret = other.redPow(this._priv).fromRed();
      var out = new Buffer(secret.toArray());
      var prime = this.getPrime();
      if (out.length < prime.length) {
        var front = new Buffer(prime.length - out.length);
        front.fill(0);
        out = Buffer.concat([front, out]);
      }
      return out;
    };
    DH.prototype.getPublicKey = function getPublicKey(enc) {
      return formatReturnValue(this._pub, enc);
    };
    DH.prototype.getPrivateKey = function getPrivateKey(enc) {
      return formatReturnValue(this._priv, enc);
    };
    DH.prototype.getPrime = function(enc) {
      return formatReturnValue(this.__prime, enc);
    };
    DH.prototype.getGenerator = function(enc) {
      return formatReturnValue(this._gen, enc);
    };
    DH.prototype.setGenerator = function(gen, enc) {
      enc = enc || 'utf8';
      if (!Buffer.isBuffer(gen)) {
        gen = new Buffer(gen, enc);
      }
      this._gen = new BN(gen);
      return this;
    };
    function formatReturnValue(bn, enc) {
      var buf = new Buffer(bn.toArray());
      if (!enc) {
        return buf;
      } else {
        return buf.toString(enc);
      }
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:indexof@0.0.1/index", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var indexOf = [].indexOf;
  module.exports = function(arr, obj) {
    if (indexOf)
      return arr.indexOf(obj);
    for (var i = 0; i < arr.length; ++i) {
      if (arr[i] === obj)
        return i;
    }
    return -1;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1/base/reporter", ["npm:inherits@2.0.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var inherits = require("npm:inherits@2.0.1");
  function Reporter(options) {
    this._reporterState = {
      obj: null,
      path: [],
      options: options || {},
      errors: []
    };
  }
  exports.Reporter = Reporter;
  Reporter.prototype.isError = function isError(obj) {
    return obj instanceof ReporterError;
  };
  Reporter.prototype.enterKey = function enterKey(key) {
    return this._reporterState.path.push(key);
  };
  Reporter.prototype.leaveKey = function leaveKey(index, key, value) {
    var state = this._reporterState;
    state.path = state.path.slice(0, index - 1);
    if (state.obj !== null)
      state.obj[key] = value;
  };
  Reporter.prototype.enterObject = function enterObject() {
    var state = this._reporterState;
    var prev = state.obj;
    state.obj = {};
    return prev;
  };
  Reporter.prototype.leaveObject = function leaveObject(prev) {
    var state = this._reporterState;
    var now = state.obj;
    state.obj = prev;
    return now;
  };
  Reporter.prototype.error = function error(msg) {
    var err;
    var state = this._reporterState;
    var inherited = msg instanceof ReporterError;
    if (inherited) {
      err = msg;
    } else {
      err = new ReporterError(state.path.map(function(elem) {
        return '[' + JSON.stringify(elem) + ']';
      }).join(''), msg.message || msg, msg.stack);
    }
    if (!state.options.partial)
      throw err;
    if (!inherited)
      state.errors.push(err);
    return err;
  };
  Reporter.prototype.wrapResult = function wrapResult(result) {
    var state = this._reporterState;
    if (!state.options.partial)
      return result;
    return {
      result: this.isError(result) ? null : result,
      errors: state.errors
    };
  };
  function ReporterError(path, msg) {
    this.path = path;
    this.rethrow(msg);
  }
  ;
  inherits(ReporterError, Error);
  ReporterError.prototype.rethrow = function rethrow(msg) {
    this.message = msg + ' at: ' + (this.path || '(shallow)');
    Error.captureStackTrace(this, ReporterError);
    return this;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1/base/buffer", ["npm:inherits@2.0.1", "npm:asn1.js@1.0.4/lib/asn1/base/index", "github:jspm/nodelibs-buffer@0.1.0", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var inherits = require("npm:inherits@2.0.1");
    var Reporter = require("npm:asn1.js@1.0.4/lib/asn1/base/index").Reporter;
    var Buffer = require("github:jspm/nodelibs-buffer@0.1.0").Buffer;
    function DecoderBuffer(base, options) {
      Reporter.call(this, options);
      if (!Buffer.isBuffer(base)) {
        this.error('Input not Buffer');
        return ;
      }
      this.base = base;
      this.offset = 0;
      this.length = base.length;
    }
    inherits(DecoderBuffer, Reporter);
    exports.DecoderBuffer = DecoderBuffer;
    DecoderBuffer.prototype.save = function save() {
      return {offset: this.offset};
    };
    DecoderBuffer.prototype.restore = function restore(save) {
      var res = new DecoderBuffer(this.base);
      res.offset = save.offset;
      res.length = this.offset;
      this.offset = save.offset;
      return res;
    };
    DecoderBuffer.prototype.isEmpty = function isEmpty() {
      return this.offset === this.length;
    };
    DecoderBuffer.prototype.readUInt8 = function readUInt8(fail) {
      if (this.offset + 1 <= this.length)
        return this.base.readUInt8(this.offset++, true);
      else
        return this.error(fail || 'DecoderBuffer overrun');
    };
    DecoderBuffer.prototype.skip = function skip(bytes, fail) {
      if (!(this.offset + bytes <= this.length))
        return this.error(fail || 'DecoderBuffer overrun');
      var res = new DecoderBuffer(this.base);
      res._reporterState = this._reporterState;
      res.offset = this.offset;
      res.length = this.offset + bytes;
      this.offset += bytes;
      return res;
    };
    DecoderBuffer.prototype.raw = function raw(save) {
      return this.base.slice(save ? save.offset : this.offset, this.length);
    };
    function EncoderBuffer(value, reporter) {
      if (Array.isArray(value)) {
        this.length = 0;
        this.value = value.map(function(item) {
          if (!(item instanceof EncoderBuffer))
            item = new EncoderBuffer(item, reporter);
          this.length += item.length;
          return item;
        }, this);
      } else if (typeof value === 'number') {
        if (!(0 <= value && value <= 0xff))
          return reporter.error('non-byte EncoderBuffer value');
        this.value = value;
        this.length = 1;
      } else if (typeof value === 'string') {
        this.value = value;
        this.length = Buffer.byteLength(value);
      } else if (Buffer.isBuffer(value)) {
        this.value = value;
        this.length = value.length;
      } else {
        return reporter.error('Unsupported type: ' + typeof value);
      }
    }
    exports.EncoderBuffer = EncoderBuffer;
    EncoderBuffer.prototype.join = function join(out, offset) {
      if (!out)
        out = new Buffer(this.length);
      if (!offset)
        offset = 0;
      if (this.length === 0)
        return out;
      if (Array.isArray(this.value)) {
        this.value.forEach(function(item) {
          item.join(out, offset);
          offset += item.length;
        });
      } else {
        if (typeof this.value === 'number')
          out[offset] = this.value;
        else if (typeof this.value === 'string')
          out.write(this.value, offset);
        else if (Buffer.isBuffer(this.value))
          this.value.copy(out, offset);
        offset += this.length;
      }
      return out;
    };
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:minimalistic-assert@1.0.0/index", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = assert;
  function assert(val, msg) {
    if (!val)
      throw new Error(msg || 'Assertion failed');
  }
  assert.equal = function assertEqual(l, r, msg) {
    if (l != r)
      throw new Error(msg || ('Assertion failed: ' + l + ' != ' + r));
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1/constants/der", ["npm:asn1.js@1.0.4/lib/asn1/constants/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var constants = require("npm:asn1.js@1.0.4/lib/asn1/constants/index");
  exports.tagClass = {
    0: 'universal',
    1: 'application',
    2: 'context',
    3: 'private'
  };
  exports.tagClassByName = constants._reverse(exports.tagClass);
  exports.tag = {
    0x00: 'end',
    0x01: 'bool',
    0x02: 'int',
    0x03: 'bitstr',
    0x04: 'octstr',
    0x05: 'null_',
    0x06: 'objid',
    0x07: 'objDesc',
    0x08: 'external',
    0x09: 'real',
    0x0a: 'enum',
    0x0b: 'embed',
    0x0c: 'utf8str',
    0x0d: 'relativeOid',
    0x10: 'seq',
    0x11: 'set',
    0x12: 'numstr',
    0x13: 'printstr',
    0x14: 't61str',
    0x15: 'videostr',
    0x16: 'ia5str',
    0x17: 'utctime',
    0x18: 'gentime',
    0x19: 'graphstr',
    0x1a: 'iso646str',
    0x1b: 'genstr',
    0x1c: 'unistr',
    0x1d: 'charstr',
    0x1e: 'bmpstr'
  };
  exports.tagByName = constants._reverse(exports.tag);
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1/decoders/der", ["npm:inherits@2.0.1", "npm:asn1.js@1.0.4/lib/asn1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var inherits = require("npm:inherits@2.0.1");
  var asn1 = require("npm:asn1.js@1.0.4/lib/asn1");
  var base = asn1.base;
  var bignum = asn1.bignum;
  var der = asn1.constants.der;
  function DERDecoder(entity) {
    this.enc = 'der';
    this.name = entity.name;
    this.entity = entity;
    this.tree = new DERNode();
    this.tree._init(entity.body);
  }
  ;
  module.exports = DERDecoder;
  DERDecoder.prototype.decode = function decode(data, options) {
    if (!(data instanceof base.DecoderBuffer))
      data = new base.DecoderBuffer(data, options);
    return this.tree._decode(data, options);
  };
  function DERNode(parent) {
    base.Node.call(this, 'der', parent);
  }
  inherits(DERNode, base.Node);
  DERNode.prototype._peekTag = function peekTag(buffer, tag) {
    if (buffer.isEmpty())
      return false;
    var state = buffer.save();
    var decodedTag = derDecodeTag(buffer, 'Failed to peek tag: "' + tag + '"');
    if (buffer.isError(decodedTag))
      return decodedTag;
    buffer.restore(state);
    return decodedTag.tag === tag || decodedTag.tagStr === tag;
  };
  DERNode.prototype._decodeTag = function decodeTag(buffer, tag, any) {
    var decodedTag = derDecodeTag(buffer, 'Failed to decode tag of "' + tag + '"');
    if (buffer.isError(decodedTag))
      return decodedTag;
    var len = derDecodeLen(buffer, decodedTag.primitive, 'Failed to get length of "' + tag + '"');
    if (buffer.isError(len))
      return len;
    if (!any && decodedTag.tag !== tag && decodedTag.tagStr !== tag && decodedTag.tagStr + 'of' !== tag) {
      return buffer.error('Failed to match tag: "' + tag + '"');
    }
    if (decodedTag.primitive || len !== null)
      return buffer.skip(len, 'Failed to match body of: "' + tag + '"');
    var state = buffer.start();
    var res = this._skipUntilEnd(buffer, 'Failed to skip indefinite length body: "' + this.tag + '"');
    if (buffer.isError(res))
      return res;
    return buffer.cut(state);
  };
  DERNode.prototype._skipUntilEnd = function skipUntilEnd(buffer, fail) {
    while (true) {
      var tag = derDecodeTag(buffer, fail);
      if (buffer.isError(tag))
        return tag;
      var len = derDecodeLen(buffer, tag.primitive, fail);
      if (buffer.isError(len))
        return len;
      var res;
      if (tag.primitive || len !== null)
        res = buffer.skip(len);
      else
        res = this._skipUntilEnd(buffer, fail);
      if (buffer.isError(res))
        return res;
      if (tag.tagStr === 'end')
        break;
    }
  };
  DERNode.prototype._decodeList = function decodeList(buffer, tag, decoder) {
    var result = [];
    while (!buffer.isEmpty()) {
      var possibleEnd = this._peekTag(buffer, 'end');
      if (buffer.isError(possibleEnd))
        return possibleEnd;
      var res = decoder.decode(buffer, 'der');
      if (buffer.isError(res) && possibleEnd)
        break;
      result.push(res);
    }
    return result;
  };
  DERNode.prototype._decodeStr = function decodeStr(buffer, tag) {
    if (tag === 'octstr') {
      return buffer.raw();
    } else if (tag === 'bitstr') {
      var unused = buffer.readUInt8();
      if (buffer.isError(unused))
        return unused;
      return {
        unused: unused,
        data: buffer.raw()
      };
    } else if (tag === 'ia5str') {
      return buffer.raw().toString();
    } else {
      return this.error('Decoding of string type: ' + tag + ' unsupported');
    }
  };
  DERNode.prototype._decodeObjid = function decodeObjid(buffer, values, relative) {
    var identifiers = [];
    var ident = 0;
    while (!buffer.isEmpty()) {
      var subident = buffer.readUInt8();
      ident <<= 7;
      ident |= subident & 0x7f;
      if ((subident & 0x80) === 0) {
        identifiers.push(ident);
        ident = 0;
      }
    }
    if (subident & 0x80)
      identifiers.push(ident);
    var first = (identifiers[0] / 40) | 0;
    var second = identifiers[0] % 40;
    if (relative)
      result = identifiers;
    else
      result = [first, second].concat(identifiers.slice(1));
    if (values)
      result = values[result.join(' ')];
    return result;
  };
  DERNode.prototype._decodeTime = function decodeTime(buffer, tag) {
    var str = buffer.raw().toString();
    if (tag === 'gentime') {
      var year = str.slice(0, 4) | 0;
      var mon = str.slice(4, 6) | 0;
      var day = str.slice(6, 8) | 0;
      var hour = str.slice(8, 10) | 0;
      var min = str.slice(10, 12) | 0;
      var sec = str.slice(12, 14) | 0;
    } else if (tag === 'utctime') {
      var year = str.slice(0, 2) | 0;
      var mon = str.slice(2, 4) | 0;
      var day = str.slice(4, 6) | 0;
      var hour = str.slice(6, 8) | 0;
      var min = str.slice(8, 10) | 0;
      var sec = str.slice(10, 12) | 0;
      if (year < 70)
        year = 2000 + year;
      else
        year = 1900 + year;
    } else {
      return this.error('Decoding ' + tag + ' time is not supported yet');
    }
    return Date.UTC(year, mon - 1, day, hour, min, sec, 0);
  };
  DERNode.prototype._decodeNull = function decodeNull(buffer) {
    return null;
  };
  DERNode.prototype._decodeBool = function decodeBool(buffer) {
    var res = buffer.readUInt8();
    if (buffer.isError(res))
      return res;
    else
      return res !== 0;
  };
  DERNode.prototype._decodeInt = function decodeInt(buffer, values) {
    var res = 0;
    var raw = buffer.raw();
    if (raw.length > 3)
      return new bignum(raw);
    while (!buffer.isEmpty()) {
      res <<= 8;
      var i = buffer.readUInt8();
      if (buffer.isError(i))
        return i;
      res |= i;
    }
    if (values)
      res = values[res] || res;
    return res;
  };
  DERNode.prototype._use = function use(entity, obj) {
    if (typeof entity === 'function')
      entity = entity(obj);
    return entity._getDecoder('der').tree;
  };
  function derDecodeTag(buf, fail) {
    var tag = buf.readUInt8(fail);
    if (buf.isError(tag))
      return tag;
    var cls = der.tagClass[tag >> 6];
    var primitive = (tag & 0x20) === 0;
    if ((tag & 0x1f) === 0x1f) {
      var oct = tag;
      tag = 0;
      while ((oct & 0x80) === 0x80) {
        oct = buf.readUInt8(fail);
        if (buf.isError(oct))
          return oct;
        tag <<= 7;
        tag |= oct & 0x7f;
      }
    } else {
      tag &= 0x1f;
    }
    var tagStr = der.tag[tag];
    return {
      cls: cls,
      primitive: primitive,
      tag: tag,
      tagStr: tagStr
    };
  }
  function derDecodeLen(buf, primitive, fail) {
    var len = buf.readUInt8(fail);
    if (buf.isError(len))
      return len;
    if (!primitive && len === 0x80)
      return null;
    if ((len & 0x80) === 0) {
      return len;
    }
    var num = len & 0x7f;
    if (num >= 4)
      return buf.error('length octect is too long');
    len = 0;
    for (var i = 0; i < num; i++) {
      len <<= 8;
      var j = buf.readUInt8(fail);
      if (buf.isError(j))
        return j;
      len |= j;
    }
    return len;
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1/encoders/der", ["npm:inherits@2.0.1", "github:jspm/nodelibs-buffer@0.1.0", "npm:asn1.js@1.0.4/lib/asn1", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var inherits = require("npm:inherits@2.0.1");
    var Buffer = require("github:jspm/nodelibs-buffer@0.1.0").Buffer;
    var asn1 = require("npm:asn1.js@1.0.4/lib/asn1");
    var base = asn1.base;
    var bignum = asn1.bignum;
    var der = asn1.constants.der;
    function DEREncoder(entity) {
      this.enc = 'der';
      this.name = entity.name;
      this.entity = entity;
      this.tree = new DERNode();
      this.tree._init(entity.body);
    }
    ;
    module.exports = DEREncoder;
    DEREncoder.prototype.encode = function encode(data, reporter) {
      return this.tree._encode(data, reporter).join();
    };
    function DERNode(parent) {
      base.Node.call(this, 'der', parent);
    }
    inherits(DERNode, base.Node);
    DERNode.prototype._encodeComposite = function encodeComposite(tag, primitive, cls, content) {
      var encodedTag = encodeTag(tag, primitive, cls, this.reporter);
      if (content.length < 0x80) {
        var header = new Buffer(2);
        header[0] = encodedTag;
        header[1] = content.length;
        return this._createEncoderBuffer([header, content]);
      }
      var lenOctets = 1;
      for (var i = content.length; i >= 0x100; i >>= 8)
        lenOctets++;
      var header = new Buffer(1 + 1 + lenOctets);
      header[0] = encodedTag;
      header[1] = 0x80 | lenOctets;
      for (var i = 1 + lenOctets,
          j = content.length; j > 0; i--, j >>= 8)
        header[i] = j & 0xff;
      return this._createEncoderBuffer([header, content]);
    };
    DERNode.prototype._encodeStr = function encodeStr(str, tag) {
      if (tag === 'octstr')
        return this._createEncoderBuffer(str);
      else if (tag === 'bitstr')
        return this._createEncoderBuffer([str.unused | 0, str.data]);
      else if (tag === 'ia5str')
        return this._createEncoderBuffer(str);
      return this.reporter.error('Encoding of string type: ' + tag + ' unsupported');
    };
    DERNode.prototype._encodeObjid = function encodeObjid(id, values, relative) {
      if (typeof id === 'string') {
        if (!values)
          return this.reporter.error('string objid given, but no values map found');
        if (!values.hasOwnProperty(id))
          return this.reporter.error('objid not found in values map');
        id = values[id].split(/\s+/g);
        for (var i = 0; i < id.length; i++)
          id[i] |= 0;
      } else if (Array.isArray(id)) {
        id = id.slice();
      }
      if (!Array.isArray(id)) {
        return this.reporter.error('objid() should be either array or string, ' + 'got: ' + JSON.stringify(id));
      }
      if (!relative) {
        if (id[1] >= 40)
          return this.reporter.error('Second objid identifier OOB');
        id.splice(0, 2, id[0] * 40 + id[1]);
      }
      var size = 0;
      for (var i = 0; i < id.length; i++) {
        var ident = id[i];
        for (size++; ident >= 0x80; ident >>= 7)
          size++;
      }
      var objid = new Buffer(size);
      var offset = objid.length - 1;
      for (var i = id.length - 1; i >= 0; i--) {
        var ident = id[i];
        objid[offset--] = ident & 0x7f;
        while ((ident >>= 7) > 0)
          objid[offset--] = 0x80 | (ident & 0x7f);
      }
      return this._createEncoderBuffer(objid);
    };
    function two(num) {
      if (num <= 10)
        return '0' + num;
      else
        return num;
    }
    DERNode.prototype._encodeTime = function encodeTime(time, tag) {
      var str;
      var date = new Date(time);
      if (tag === 'gentime') {
        str = [date.getFullYear(), two(date.getUTCMonth() + 1), two(date.getUTCDate()), two(date.getUTCHours()), two(date.getUTCMinutes()), two(date.getUTCSeconds()), 'Z'].join('');
      } else if (tag === 'utctime') {
        str = [date.getFullYear() % 100, two(date.getUTCMonth() + 1), two(date.getUTCDate()), two(date.getUTCHours()), two(date.getUTCMinutes()), two(date.getUTCSeconds()), 'Z'].join('');
      } else {
        this.reporter.error('Encoding ' + tag + ' time is not supported yet');
      }
      return this._encodeStr(str, 'octstr');
    };
    DERNode.prototype._encodeNull = function encodeNull() {
      return this._createEncoderBuffer('');
    };
    DERNode.prototype._encodeInt = function encodeInt(num, values) {
      if (typeof num === 'string') {
        if (!values)
          return this.reporter.error('String int or enum given, but no values map');
        if (!values.hasOwnProperty(num)) {
          return this.reporter.error('Values map doesn\'t contain: ' + JSON.stringify(num));
        }
        num = values[num];
      }
      if (bignum !== null && num instanceof bignum) {
        var numArray = num.toArray();
        if (num.sign === false && numArray[0] & 0x80) {
          numArray.unshift(0);
        }
        num = new Buffer(numArray);
      }
      if (Buffer.isBuffer(num)) {
        var size = num.length;
        if (num.length === 0)
          size++;
        var out = new Buffer(size);
        num.copy(out);
        if (num.length === 0)
          out[0] = 0;
        return this._createEncoderBuffer(out);
      }
      if (num < 0x80)
        return this._createEncoderBuffer(num);
      if (num < 0x100)
        return this._createEncoderBuffer([0, num]);
      var size = 1;
      for (var i = num; i >= 0x100; i >>= 8)
        size++;
      var out = new Array(size);
      for (var i = out.length - 1; i >= 0; i--) {
        out[i] = num & 0xff;
        num >>= 8;
      }
      if (out[0] & 0x80) {
        out.unshift(0);
      }
      return this._createEncoderBuffer(new Buffer(out));
    };
    DERNode.prototype._encodeBool = function encodeBool(value) {
      return this._createEncoderBuffer(value ? 0xff : 0);
    };
    DERNode.prototype._use = function use(entity, obj) {
      if (typeof entity === 'function')
        entity = entity(obj);
      return entity._getEncoder('der').tree;
    };
    DERNode.prototype._skipDefault = function skipDefault(dataBuffer, reporter, parent) {
      var state = this._baseState;
      var i;
      if (state['default'] === null)
        return false;
      var data = dataBuffer.join();
      if (state.defaultBuffer === undefined)
        state.defaultBuffer = this._encodeValue(state['default'], reporter, parent).join();
      if (data.length !== state.defaultBuffer.length)
        return false;
      for (i = 0; i < data.length; i++)
        if (data[i] !== state.defaultBuffer[i])
          return false;
      return true;
    };
    function encodeTag(tag, primitive, cls, reporter) {
      var res;
      if (tag === 'seqof')
        tag = 'seq';
      else if (tag === 'setof')
        tag = 'set';
      if (der.tagByName.hasOwnProperty(tag))
        res = der.tagByName[tag];
      else if (typeof tag === 'number' && (tag | 0) === tag)
        res = tag;
      else
        return reporter.error('Unknown tag: ' + tag);
      if (res >= 0x1f)
        return reporter.error('Multi-octet tag encoding unsupported');
      if (!primitive)
        res |= 0x20;
      res |= (der.tagClassByName[cls || 'universal'] << 6);
      return res;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:parse-asn1@3.0.0/aesid.json!github:systemjs/plugin-json@0.1.0", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "2.16.840.1.101.3.4.1.1": "aes-128-ecb",
    "2.16.840.1.101.3.4.1.2": "aes-128-cbc",
    "2.16.840.1.101.3.4.1.3": "aes-128-ofb",
    "2.16.840.1.101.3.4.1.4": "aes-128-cfb",
    "2.16.840.1.101.3.4.1.21": "aes-192-ecb",
    "2.16.840.1.101.3.4.1.22": "aes-192-cbc",
    "2.16.840.1.101.3.4.1.23": "aes-192-ofb",
    "2.16.840.1.101.3.4.1.24": "aes-192-cfb",
    "2.16.840.1.101.3.4.1.41": "aes-256-ecb",
    "2.16.840.1.101.3.4.1.42": "aes-256-cbc",
    "2.16.840.1.101.3.4.1.43": "aes-256-ofb",
    "2.16.840.1.101.3.4.1.44": "aes-256-cfb"
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:parse-asn1@3.0.0/EVP_BytesToKey", ["npm:create-hash@1.1.1", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var createHash = require("npm:create-hash@1.1.1");
    module.exports = function evp(password, salt, keyLen) {
      keyLen = keyLen / 8;
      var ki = 0;
      var ii = 0;
      var key = new Buffer(keyLen);
      var addmd = 0;
      var md,
          md_buf;
      var i;
      while (true) {
        md = createHash('md5');
        if (addmd++ > 0) {
          md.update(md_buf);
        }
        md.update(password);
        md.update(salt);
        md_buf = md.digest();
        i = 0;
        if (keyLen > 0) {
          while (true) {
            if (keyLen === 0) {
              break;
            }
            if (i === md_buf.length) {
              break;
            }
            key[ki++] = md_buf[i++];
            keyLen--;
          }
        }
        if (keyLen === 0) {
          break;
        }
      }
      for (i = 0; i < md_buf.length; i++) {
        md_buf[i] = 0;
      }
      return key;
    };
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:pbkdf2-compat@3.0.2/browser", ["npm:create-hmac@1.1.3", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var createHmac = require("npm:create-hmac@1.1.3");
    exports.pbkdf2 = pbkdf2;
    function pbkdf2(password, salt, iterations, keylen, digest, callback) {
      if (typeof digest === 'function') {
        callback = digest;
        digest = undefined;
      }
      if (typeof callback !== 'function') {
        throw new Error('No callback provided to pbkdf2');
      }
      var result = pbkdf2Sync(password, salt, iterations, keylen, digest);
      setTimeout(function() {
        callback(undefined, result);
      });
    }
    exports.pbkdf2Sync = pbkdf2Sync;
    function pbkdf2Sync(password, salt, iterations, keylen, digest) {
      if (typeof iterations !== 'number')
        throw new TypeError('Iterations not a number');
      if (iterations < 0)
        throw new TypeError('Bad iterations');
      if (typeof keylen !== 'number')
        throw new TypeError('Key length not a number');
      if (keylen < 0)
        throw new TypeError('Bad key length');
      digest = digest || 'sha1';
      if (!Buffer.isBuffer(password))
        password = new Buffer(password);
      if (!Buffer.isBuffer(salt))
        salt = new Buffer(salt);
      var hLen;
      var l = 1;
      var DK = new Buffer(keylen);
      var block1 = new Buffer(salt.length + 4);
      salt.copy(block1, 0, 0, salt.length);
      var r;
      var T;
      for (var i = 1; i <= l; i++) {
        block1.writeUInt32BE(i, salt.length);
        var U = createHmac(digest, password).update(block1).digest();
        if (!hLen) {
          hLen = U.length;
          T = new Buffer(hLen);
          l = Math.ceil(keylen / hLen);
          r = keylen - (l - 1) * hLen;
          if (keylen > (Math.pow(2, 32) - 1) * hLen)
            throw new TypeError('keylen exceeds maximum length');
        }
        U.copy(T, 0, 0, hLen);
        for (var j = 1; j < iterations; j++) {
          U = createHmac(digest, password).update(U).digest();
          for (var k = 0; k < hLen; k++) {
            T[k] ^= U[k];
          }
        }
        var destPos = (i - 1) * hLen;
        var len = (i === l ? r : hLen);
        T.copy(DK, destPos, 0, len);
      }
      return DK;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/package.json!github:systemjs/plugin-json@0.1.0", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "name": "elliptic",
    "version": "1.0.1",
    "description": "EC cryptography",
    "main": "lib/elliptic.js",
    "scripts": {"test": "mocha --reporter=spec test/*-test.js"},
    "repository": {
      "type": "git",
      "url": "git@github.com:indutny/elliptic"
    },
    "keywords": ["EC", "Elliptic", "curve", "Cryptography"],
    "author": "Fedor Indutny <fedor@indutny.com>",
    "license": "MIT",
    "bugs": {"url": "https://github.com/indutny/elliptic/issues"},
    "homepage": "https://github.com/indutny/elliptic",
    "devDependencies": {
      "browserify": "^3.44.2",
      "mocha": "^1.18.2",
      "uglify-js": "^2.4.13"
    },
    "dependencies": {
      "bn.js": "^1.0.0",
      "brorand": "^1.0.1",
      "hash.js": "^1.0.0",
      "inherits": "^2.0.1"
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic/utils", ["npm:bn.js@1.3.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var bn = require("npm:bn.js@1.3.0");
  var utils = exports;
  utils.assert = function assert(val, msg) {
    if (!val)
      throw new Error(msg || 'Assertion failed');
  };
  function toArray(msg, enc) {
    if (Array.isArray(msg))
      return msg.slice();
    if (!msg)
      return [];
    var res = [];
    if (typeof msg === 'string') {
      if (!enc) {
        for (var i = 0; i < msg.length; i++) {
          var c = msg.charCodeAt(i);
          var hi = c >> 8;
          var lo = c & 0xff;
          if (hi)
            res.push(hi, lo);
          else
            res.push(lo);
        }
      } else if (enc === 'hex') {
        msg = msg.replace(/[^a-z0-9]+/ig, '');
        if (msg.length % 2 !== 0)
          msg = '0' + msg;
        for (var i = 0; i < msg.length; i += 2)
          res.push(parseInt(msg[i] + msg[i + 1], 16));
      }
    } else {
      for (var i = 0; i < msg.length; i++)
        res[i] = msg[i] | 0;
    }
    return res;
  }
  utils.toArray = toArray;
  function toHex(msg) {
    var res = '';
    for (var i = 0; i < msg.length; i++)
      res += zero2(msg[i].toString(16));
    return res;
  }
  utils.toHex = toHex;
  utils.encode = function encode(arr, enc) {
    if (enc === 'hex')
      return toHex(arr);
    else
      return arr;
  };
  function zero2(word) {
    if (word.length === 1)
      return '0' + word;
    else
      return word;
  }
  utils.zero2 = zero2;
  function getNAF(num, w) {
    var naf = [];
    var ws = 1 << (w + 1);
    var k = num.clone();
    while (k.cmpn(1) >= 0) {
      var z;
      if (k.isOdd()) {
        var mod = k.andln(ws - 1);
        if (mod > (ws >> 1) - 1)
          z = (ws >> 1) - mod;
        else
          z = mod;
        k.isubn(z);
      } else {
        z = 0;
      }
      naf.push(z);
      var shift = (k.cmpn(0) !== 0 && k.andln(ws - 1) === 0) ? (w + 1) : 1;
      for (var i = 1; i < shift; i++)
        naf.push(0);
      k.ishrn(shift);
    }
    return naf;
  }
  utils.getNAF = getNAF;
  function getJSF(k1, k2) {
    var jsf = [[], []];
    k1 = k1.clone();
    k2 = k2.clone();
    var d1 = 0;
    var d2 = 0;
    while (k1.cmpn(-d1) > 0 || k2.cmpn(-d2) > 0) {
      var m14 = (k1.andln(3) + d1) & 3;
      var m24 = (k2.andln(3) + d2) & 3;
      if (m14 === 3)
        m14 = -1;
      if (m24 === 3)
        m24 = -1;
      var u1;
      if ((m14 & 1) === 0) {
        u1 = 0;
      } else {
        var m8 = (k1.andln(7) + d1) & 7;
        if ((m8 === 3 || m8 === 5) && m24 === 2)
          u1 = -m14;
        else
          u1 = m14;
      }
      jsf[0].push(u1);
      var u2;
      if ((m24 & 1) === 0) {
        u2 = 0;
      } else {
        var m8 = (k2.andln(7) + d2) & 7;
        if ((m8 === 3 || m8 === 5) && m14 === 2)
          u2 = -m24;
        else
          u2 = m24;
      }
      jsf[1].push(u2);
      if (2 * d1 === u1 + 1)
        d1 = 1 - d1;
      if (2 * d2 === u2 + 1)
        d2 = 1 - d2;
      k1.ishrn(1);
      k2.ishrn(1);
    }
    return jsf;
  }
  utils.getJSF = getJSF;
  global.define = __define;
  return module.exports;
});

System.register("npm:hash.js@1.0.2/lib/hash/utils", ["npm:inherits@2.0.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var utils = exports;
  var inherits = require("npm:inherits@2.0.1");
  function toArray(msg, enc) {
    if (Array.isArray(msg))
      return msg.slice();
    if (!msg)
      return [];
    var res = [];
    if (typeof msg === 'string') {
      if (!enc) {
        for (var i = 0; i < msg.length; i++) {
          var c = msg.charCodeAt(i);
          var hi = c >> 8;
          var lo = c & 0xff;
          if (hi)
            res.push(hi, lo);
          else
            res.push(lo);
        }
      } else if (enc === 'hex') {
        msg = msg.replace(/[^a-z0-9]+/ig, '');
        if (msg.length % 2 !== 0)
          msg = '0' + msg;
        for (var i = 0; i < msg.length; i += 2)
          res.push(parseInt(msg[i] + msg[i + 1], 16));
      }
    } else {
      for (var i = 0; i < msg.length; i++)
        res[i] = msg[i] | 0;
    }
    return res;
  }
  utils.toArray = toArray;
  function toHex(msg) {
    var res = '';
    for (var i = 0; i < msg.length; i++)
      res += zero2(msg[i].toString(16));
    return res;
  }
  utils.toHex = toHex;
  function htonl(w) {
    var res = (w >>> 24) | ((w >>> 8) & 0xff00) | ((w << 8) & 0xff0000) | ((w & 0xff) << 24);
    return res >>> 0;
  }
  utils.htonl = htonl;
  function toHex32(msg, endian) {
    var res = '';
    for (var i = 0; i < msg.length; i++) {
      var w = msg[i];
      if (endian === 'little')
        w = htonl(w);
      res += zero8(w.toString(16));
    }
    return res;
  }
  utils.toHex32 = toHex32;
  function zero2(word) {
    if (word.length === 1)
      return '0' + word;
    else
      return word;
  }
  utils.zero2 = zero2;
  function zero8(word) {
    if (word.length === 7)
      return '0' + word;
    else if (word.length === 6)
      return '00' + word;
    else if (word.length === 5)
      return '000' + word;
    else if (word.length === 4)
      return '0000' + word;
    else if (word.length === 3)
      return '00000' + word;
    else if (word.length === 2)
      return '000000' + word;
    else if (word.length === 1)
      return '0000000' + word;
    else
      return word;
  }
  utils.zero8 = zero8;
  function join32(msg, start, end, endian) {
    var len = end - start;
    assert(len % 4 === 0);
    var res = new Array(len / 4);
    for (var i = 0,
        k = start; i < res.length; i++, k += 4) {
      var w;
      if (endian === 'big')
        w = (msg[k] << 24) | (msg[k + 1] << 16) | (msg[k + 2] << 8) | msg[k + 3];
      else
        w = (msg[k + 3] << 24) | (msg[k + 2] << 16) | (msg[k + 1] << 8) | msg[k];
      res[i] = w >>> 0;
    }
    return res;
  }
  utils.join32 = join32;
  function split32(msg, endian) {
    var res = new Array(msg.length * 4);
    for (var i = 0,
        k = 0; i < msg.length; i++, k += 4) {
      var m = msg[i];
      if (endian === 'big') {
        res[k] = m >>> 24;
        res[k + 1] = (m >>> 16) & 0xff;
        res[k + 2] = (m >>> 8) & 0xff;
        res[k + 3] = m & 0xff;
      } else {
        res[k + 3] = m >>> 24;
        res[k + 2] = (m >>> 16) & 0xff;
        res[k + 1] = (m >>> 8) & 0xff;
        res[k] = m & 0xff;
      }
    }
    return res;
  }
  utils.split32 = split32;
  function rotr32(w, b) {
    return (w >>> b) | (w << (32 - b));
  }
  utils.rotr32 = rotr32;
  function rotl32(w, b) {
    return (w << b) | (w >>> (32 - b));
  }
  utils.rotl32 = rotl32;
  function sum32(a, b) {
    return (a + b) >>> 0;
  }
  utils.sum32 = sum32;
  function sum32_3(a, b, c) {
    return (a + b + c) >>> 0;
  }
  utils.sum32_3 = sum32_3;
  function sum32_4(a, b, c, d) {
    return (a + b + c + d) >>> 0;
  }
  utils.sum32_4 = sum32_4;
  function sum32_5(a, b, c, d, e) {
    return (a + b + c + d + e) >>> 0;
  }
  utils.sum32_5 = sum32_5;
  function assert(cond, msg) {
    if (!cond)
      throw new Error(msg || 'Assertion failed');
  }
  utils.assert = assert;
  utils.inherits = inherits;
  function sum64(buf, pos, ah, al) {
    var bh = buf[pos];
    var bl = buf[pos + 1];
    var lo = (al + bl) >>> 0;
    var hi = (lo < al ? 1 : 0) + ah + bh;
    buf[pos] = hi >>> 0;
    buf[pos + 1] = lo;
  }
  exports.sum64 = sum64;
  function sum64_hi(ah, al, bh, bl) {
    var lo = (al + bl) >>> 0;
    var hi = (lo < al ? 1 : 0) + ah + bh;
    return hi >>> 0;
  }
  ;
  exports.sum64_hi = sum64_hi;
  function sum64_lo(ah, al, bh, bl) {
    var lo = al + bl;
    return lo >>> 0;
  }
  ;
  exports.sum64_lo = sum64_lo;
  function sum64_4_hi(ah, al, bh, bl, ch, cl, dh, dl) {
    var carry = 0;
    var lo = al;
    lo = (lo + bl) >>> 0;
    carry += lo < al ? 1 : 0;
    lo = (lo + cl) >>> 0;
    carry += lo < cl ? 1 : 0;
    lo = (lo + dl) >>> 0;
    carry += lo < dl ? 1 : 0;
    var hi = ah + bh + ch + dh + carry;
    return hi >>> 0;
  }
  ;
  exports.sum64_4_hi = sum64_4_hi;
  function sum64_4_lo(ah, al, bh, bl, ch, cl, dh, dl) {
    var lo = al + bl + cl + dl;
    return lo >>> 0;
  }
  ;
  exports.sum64_4_lo = sum64_4_lo;
  function sum64_5_hi(ah, al, bh, bl, ch, cl, dh, dl, eh, el) {
    var carry = 0;
    var lo = al;
    lo = (lo + bl) >>> 0;
    carry += lo < al ? 1 : 0;
    lo = (lo + cl) >>> 0;
    carry += lo < cl ? 1 : 0;
    lo = (lo + dl) >>> 0;
    carry += lo < dl ? 1 : 0;
    lo = (lo + el) >>> 0;
    carry += lo < el ? 1 : 0;
    var hi = ah + bh + ch + dh + eh + carry;
    return hi >>> 0;
  }
  ;
  exports.sum64_5_hi = sum64_5_hi;
  function sum64_5_lo(ah, al, bh, bl, ch, cl, dh, dl, eh, el) {
    var lo = al + bl + cl + dl + el;
    return lo >>> 0;
  }
  ;
  exports.sum64_5_lo = sum64_5_lo;
  function rotr64_hi(ah, al, num) {
    var r = (al << (32 - num)) | (ah >>> num);
    return r >>> 0;
  }
  ;
  exports.rotr64_hi = rotr64_hi;
  function rotr64_lo(ah, al, num) {
    var r = (ah << (32 - num)) | (al >>> num);
    return r >>> 0;
  }
  ;
  exports.rotr64_lo = rotr64_lo;
  function shr64_hi(ah, al, num) {
    return ah >>> num;
  }
  ;
  exports.shr64_hi = shr64_hi;
  function shr64_lo(ah, al, num) {
    var r = (ah << (32 - num)) | (al >>> num);
    return r >>> 0;
  }
  ;
  exports.shr64_lo = shr64_lo;
  global.define = __define;
  return module.exports;
});

System.register("npm:hash.js@1.0.2/lib/hash/common", ["npm:hash.js@1.0.2/lib/hash"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var hash = require("npm:hash.js@1.0.2/lib/hash");
  var utils = hash.utils;
  var assert = utils.assert;
  function BlockHash() {
    this.pending = null;
    this.pendingTotal = 0;
    this.blockSize = this.constructor.blockSize;
    this.outSize = this.constructor.outSize;
    this.hmacStrength = this.constructor.hmacStrength;
    this.padLength = this.constructor.padLength / 8;
    this.endian = 'big';
    this._delta8 = this.blockSize / 8;
    this._delta32 = this.blockSize / 32;
  }
  exports.BlockHash = BlockHash;
  BlockHash.prototype.update = function update(msg, enc) {
    msg = utils.toArray(msg, enc);
    if (!this.pending)
      this.pending = msg;
    else
      this.pending = this.pending.concat(msg);
    this.pendingTotal += msg.length;
    if (this.pending.length >= this._delta8) {
      msg = this.pending;
      var r = msg.length % this._delta8;
      this.pending = msg.slice(msg.length - r, msg.length);
      if (this.pending.length === 0)
        this.pending = null;
      msg = utils.join32(msg, 0, msg.length - r, this.endian);
      for (var i = 0; i < msg.length; i += this._delta32)
        this._update(msg, i, i + this._delta32);
    }
    return this;
  };
  BlockHash.prototype.digest = function digest(enc) {
    this.update(this._pad());
    assert(this.pending === null);
    return this._digest(enc);
  };
  BlockHash.prototype._pad = function pad() {
    var len = this.pendingTotal;
    var bytes = this._delta8;
    var k = bytes - ((len + this.padLength) % bytes);
    var res = new Array(k + this.padLength);
    res[0] = 0x80;
    for (var i = 1; i < k; i++)
      res[i] = 0;
    len <<= 3;
    if (this.endian === 'big') {
      for (var t = 8; t < this.padLength; t++)
        res[i++] = 0;
      res[i++] = 0;
      res[i++] = 0;
      res[i++] = 0;
      res[i++] = 0;
      res[i++] = (len >>> 24) & 0xff;
      res[i++] = (len >>> 16) & 0xff;
      res[i++] = (len >>> 8) & 0xff;
      res[i++] = len & 0xff;
    } else {
      res[i++] = len & 0xff;
      res[i++] = (len >>> 8) & 0xff;
      res[i++] = (len >>> 16) & 0xff;
      res[i++] = (len >>> 24) & 0xff;
      res[i++] = 0;
      res[i++] = 0;
      res[i++] = 0;
      res[i++] = 0;
      for (var t = 8; t < this.padLength; t++)
        res[i++] = 0;
    }
    return res;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:hash.js@1.0.2/lib/hash/sha", ["npm:hash.js@1.0.2/lib/hash"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var hash = require("npm:hash.js@1.0.2/lib/hash");
  var utils = hash.utils;
  var assert = utils.assert;
  var rotr32 = utils.rotr32;
  var rotl32 = utils.rotl32;
  var sum32 = utils.sum32;
  var sum32_4 = utils.sum32_4;
  var sum32_5 = utils.sum32_5;
  var rotr64_hi = utils.rotr64_hi;
  var rotr64_lo = utils.rotr64_lo;
  var shr64_hi = utils.shr64_hi;
  var shr64_lo = utils.shr64_lo;
  var sum64 = utils.sum64;
  var sum64_hi = utils.sum64_hi;
  var sum64_lo = utils.sum64_lo;
  var sum64_4_hi = utils.sum64_4_hi;
  var sum64_4_lo = utils.sum64_4_lo;
  var sum64_5_hi = utils.sum64_5_hi;
  var sum64_5_lo = utils.sum64_5_lo;
  var BlockHash = hash.common.BlockHash;
  var sha256_K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  var sha512_K = [0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65, 0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b, 0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3, 0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec, 0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817];
  var sha1_K = [0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xCA62C1D6];
  function SHA256() {
    if (!(this instanceof SHA256))
      return new SHA256();
    BlockHash.call(this);
    this.h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    this.k = sha256_K;
    this.W = new Array(64);
  }
  utils.inherits(SHA256, BlockHash);
  exports.sha256 = SHA256;
  SHA256.blockSize = 512;
  SHA256.outSize = 256;
  SHA256.hmacStrength = 192;
  SHA256.padLength = 64;
  SHA256.prototype._update = function _update(msg, start) {
    var W = this.W;
    for (var i = 0; i < 16; i++)
      W[i] = msg[start + i];
    for (; i < W.length; i++)
      W[i] = sum32_4(g1_256(W[i - 2]), W[i - 7], g0_256(W[i - 15]), W[i - 16]);
    var a = this.h[0];
    var b = this.h[1];
    var c = this.h[2];
    var d = this.h[3];
    var e = this.h[4];
    var f = this.h[5];
    var g = this.h[6];
    var h = this.h[7];
    assert(this.k.length === W.length);
    for (var i = 0; i < W.length; i++) {
      var T1 = sum32_5(h, s1_256(e), ch32(e, f, g), this.k[i], W[i]);
      var T2 = sum32(s0_256(a), maj32(a, b, c));
      h = g;
      g = f;
      f = e;
      e = sum32(d, T1);
      d = c;
      c = b;
      b = a;
      a = sum32(T1, T2);
    }
    this.h[0] = sum32(this.h[0], a);
    this.h[1] = sum32(this.h[1], b);
    this.h[2] = sum32(this.h[2], c);
    this.h[3] = sum32(this.h[3], d);
    this.h[4] = sum32(this.h[4], e);
    this.h[5] = sum32(this.h[5], f);
    this.h[6] = sum32(this.h[6], g);
    this.h[7] = sum32(this.h[7], h);
  };
  SHA256.prototype._digest = function digest(enc) {
    if (enc === 'hex')
      return utils.toHex32(this.h, 'big');
    else
      return utils.split32(this.h, 'big');
  };
  function SHA224() {
    if (!(this instanceof SHA224))
      return new SHA224();
    SHA256.call(this);
    this.h = [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4];
  }
  utils.inherits(SHA224, SHA256);
  exports.sha224 = SHA224;
  SHA224.blockSize = 512;
  SHA224.outSize = 224;
  SHA224.hmacStrength = 192;
  SHA224.padLength = 64;
  SHA224.prototype._digest = function digest(enc) {
    if (enc === 'hex')
      return utils.toHex32(this.h.slice(0, 7), 'big');
    else
      return utils.split32(this.h.slice(0, 7), 'big');
  };
  function SHA512() {
    if (!(this instanceof SHA512))
      return new SHA512();
    BlockHash.call(this);
    this.h = [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1, 0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179];
    this.k = sha512_K;
    this.W = new Array(160);
  }
  utils.inherits(SHA512, BlockHash);
  exports.sha512 = SHA512;
  SHA512.blockSize = 1024;
  SHA512.outSize = 512;
  SHA512.hmacStrength = 192;
  SHA512.padLength = 128;
  SHA512.prototype._prepareBlock = function _prepareBlock(msg, start) {
    var W = this.W;
    for (var i = 0; i < 32; i++)
      W[i] = msg[start + i];
    for (; i < W.length; i += 2) {
      var c0_hi = g1_512_hi(W[i - 4], W[i - 3]);
      var c0_lo = g1_512_lo(W[i - 4], W[i - 3]);
      var c1_hi = W[i - 14];
      var c1_lo = W[i - 13];
      var c2_hi = g0_512_hi(W[i - 30], W[i - 29]);
      var c2_lo = g0_512_lo(W[i - 30], W[i - 29]);
      var c3_hi = W[i - 32];
      var c3_lo = W[i - 31];
      W[i] = sum64_4_hi(c0_hi, c0_lo, c1_hi, c1_lo, c2_hi, c2_lo, c3_hi, c3_lo);
      W[i + 1] = sum64_4_lo(c0_hi, c0_lo, c1_hi, c1_lo, c2_hi, c2_lo, c3_hi, c3_lo);
    }
  };
  SHA512.prototype._update = function _update(msg, start) {
    this._prepareBlock(msg, start);
    var W = this.W;
    var ah = this.h[0];
    var al = this.h[1];
    var bh = this.h[2];
    var bl = this.h[3];
    var ch = this.h[4];
    var cl = this.h[5];
    var dh = this.h[6];
    var dl = this.h[7];
    var eh = this.h[8];
    var el = this.h[9];
    var fh = this.h[10];
    var fl = this.h[11];
    var gh = this.h[12];
    var gl = this.h[13];
    var hh = this.h[14];
    var hl = this.h[15];
    assert(this.k.length === W.length);
    for (var i = 0; i < W.length; i += 2) {
      var c0_hi = hh;
      var c0_lo = hl;
      var c1_hi = s1_512_hi(eh, el);
      var c1_lo = s1_512_lo(eh, el);
      var c2_hi = ch64_hi(eh, el, fh, fl, gh, gl);
      var c2_lo = ch64_lo(eh, el, fh, fl, gh, gl);
      var c3_hi = this.k[i];
      var c3_lo = this.k[i + 1];
      var c4_hi = W[i];
      var c4_lo = W[i + 1];
      var T1_hi = sum64_5_hi(c0_hi, c0_lo, c1_hi, c1_lo, c2_hi, c2_lo, c3_hi, c3_lo, c4_hi, c4_lo);
      var T1_lo = sum64_5_lo(c0_hi, c0_lo, c1_hi, c1_lo, c2_hi, c2_lo, c3_hi, c3_lo, c4_hi, c4_lo);
      var c0_hi = s0_512_hi(ah, al);
      var c0_lo = s0_512_lo(ah, al);
      var c1_hi = maj64_hi(ah, al, bh, bl, ch, cl);
      var c1_lo = maj64_lo(ah, al, bh, bl, ch, cl);
      var T2_hi = sum64_hi(c0_hi, c0_lo, c1_hi, c1_lo);
      var T2_lo = sum64_lo(c0_hi, c0_lo, c1_hi, c1_lo);
      hh = gh;
      hl = gl;
      gh = fh;
      gl = fl;
      fh = eh;
      fl = el;
      eh = sum64_hi(dh, dl, T1_hi, T1_lo);
      el = sum64_lo(dl, dl, T1_hi, T1_lo);
      dh = ch;
      dl = cl;
      ch = bh;
      cl = bl;
      bh = ah;
      bl = al;
      ah = sum64_hi(T1_hi, T1_lo, T2_hi, T2_lo);
      al = sum64_lo(T1_hi, T1_lo, T2_hi, T2_lo);
    }
    sum64(this.h, 0, ah, al);
    sum64(this.h, 2, bh, bl);
    sum64(this.h, 4, ch, cl);
    sum64(this.h, 6, dh, dl);
    sum64(this.h, 8, eh, el);
    sum64(this.h, 10, fh, fl);
    sum64(this.h, 12, gh, gl);
    sum64(this.h, 14, hh, hl);
  };
  SHA512.prototype._digest = function digest(enc) {
    if (enc === 'hex')
      return utils.toHex32(this.h, 'big');
    else
      return utils.split32(this.h, 'big');
  };
  function SHA384() {
    if (!(this instanceof SHA384))
      return new SHA384();
    SHA512.call(this);
    this.h = [0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939, 0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4];
  }
  utils.inherits(SHA384, SHA512);
  exports.sha384 = SHA384;
  SHA384.blockSize = 1024;
  SHA384.outSize = 384;
  SHA384.hmacStrength = 192;
  SHA384.padLength = 128;
  SHA384.prototype._digest = function digest(enc) {
    if (enc === 'hex')
      return utils.toHex32(this.h.slice(0, 12), 'big');
    else
      return utils.split32(this.h.slice(0, 12), 'big');
  };
  function SHA1() {
    if (!(this instanceof SHA1))
      return new SHA1();
    BlockHash.call(this);
    this.h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    this.W = new Array(80);
  }
  utils.inherits(SHA1, BlockHash);
  exports.sha1 = SHA1;
  SHA1.blockSize = 512;
  SHA1.outSize = 160;
  SHA1.hmacStrength = 80;
  SHA1.padLength = 64;
  SHA1.prototype._update = function _update(msg, start) {
    var W = this.W;
    for (var i = 0; i < 16; i++)
      W[i] = msg[start + i];
    for (; i < W.length; i++)
      W[i] = rotl32(W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16], 1);
    var a = this.h[0];
    var b = this.h[1];
    var c = this.h[2];
    var d = this.h[3];
    var e = this.h[4];
    for (var i = 0; i < W.length; i++) {
      var s = ~~(i / 20);
      var t = sum32_5(rotl32(a, 5), ft_1(s, b, c, d), e, W[i], sha1_K[s]);
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = t;
    }
    this.h[0] = sum32(this.h[0], a);
    this.h[1] = sum32(this.h[1], b);
    this.h[2] = sum32(this.h[2], c);
    this.h[3] = sum32(this.h[3], d);
    this.h[4] = sum32(this.h[4], e);
  };
  SHA1.prototype._digest = function digest(enc) {
    if (enc === 'hex')
      return utils.toHex32(this.h, 'big');
    else
      return utils.split32(this.h, 'big');
  };
  function ch32(x, y, z) {
    return (x & y) ^ ((~x) & z);
  }
  function maj32(x, y, z) {
    return (x & y) ^ (x & z) ^ (y & z);
  }
  function p32(x, y, z) {
    return x ^ y ^ z;
  }
  function s0_256(x) {
    return rotr32(x, 2) ^ rotr32(x, 13) ^ rotr32(x, 22);
  }
  function s1_256(x) {
    return rotr32(x, 6) ^ rotr32(x, 11) ^ rotr32(x, 25);
  }
  function g0_256(x) {
    return rotr32(x, 7) ^ rotr32(x, 18) ^ (x >>> 3);
  }
  function g1_256(x) {
    return rotr32(x, 17) ^ rotr32(x, 19) ^ (x >>> 10);
  }
  function ft_1(s, x, y, z) {
    if (s === 0)
      return ch32(x, y, z);
    if (s === 1 || s === 3)
      return p32(x, y, z);
    if (s === 2)
      return maj32(x, y, z);
  }
  function ch64_hi(xh, xl, yh, yl, zh, zl) {
    var r = (xh & yh) ^ ((~xh) & zh);
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  function ch64_lo(xh, xl, yh, yl, zh, zl) {
    var r = (xl & yl) ^ ((~xl) & zl);
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  function maj64_hi(xh, xl, yh, yl, zh, zl) {
    var r = (xh & yh) ^ (xh & zh) ^ (yh & zh);
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  function maj64_lo(xh, xl, yh, yl, zh, zl) {
    var r = (xl & yl) ^ (xl & zl) ^ (yl & zl);
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  function s0_512_hi(xh, xl) {
    var c0_hi = rotr64_hi(xh, xl, 28);
    var c1_hi = rotr64_hi(xl, xh, 2);
    var c2_hi = rotr64_hi(xl, xh, 7);
    var r = c0_hi ^ c1_hi ^ c2_hi;
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  function s0_512_lo(xh, xl) {
    var c0_lo = rotr64_lo(xh, xl, 28);
    var c1_lo = rotr64_lo(xl, xh, 2);
    var c2_lo = rotr64_lo(xl, xh, 7);
    var r = c0_lo ^ c1_lo ^ c2_lo;
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  function s1_512_hi(xh, xl) {
    var c0_hi = rotr64_hi(xh, xl, 14);
    var c1_hi = rotr64_hi(xh, xl, 18);
    var c2_hi = rotr64_hi(xl, xh, 9);
    var r = c0_hi ^ c1_hi ^ c2_hi;
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  function s1_512_lo(xh, xl) {
    var c0_lo = rotr64_lo(xh, xl, 14);
    var c1_lo = rotr64_lo(xh, xl, 18);
    var c2_lo = rotr64_lo(xl, xh, 9);
    var r = c0_lo ^ c1_lo ^ c2_lo;
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  function g0_512_hi(xh, xl) {
    var c0_hi = rotr64_hi(xh, xl, 1);
    var c1_hi = rotr64_hi(xh, xl, 8);
    var c2_hi = shr64_hi(xh, xl, 7);
    var r = c0_hi ^ c1_hi ^ c2_hi;
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  function g0_512_lo(xh, xl) {
    var c0_lo = rotr64_lo(xh, xl, 1);
    var c1_lo = rotr64_lo(xh, xl, 8);
    var c2_lo = shr64_lo(xh, xl, 7);
    var r = c0_lo ^ c1_lo ^ c2_lo;
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  function g1_512_hi(xh, xl) {
    var c0_hi = rotr64_hi(xh, xl, 19);
    var c1_hi = rotr64_hi(xl, xh, 29);
    var c2_hi = shr64_hi(xh, xl, 6);
    var r = c0_hi ^ c1_hi ^ c2_hi;
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  function g1_512_lo(xh, xl) {
    var c0_lo = rotr64_lo(xh, xl, 19);
    var c1_lo = rotr64_lo(xl, xh, 29);
    var c2_lo = shr64_lo(xh, xl, 6);
    var r = c0_lo ^ c1_lo ^ c2_lo;
    if (r < 0)
      r += 0x100000000;
    return r;
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:hash.js@1.0.2/lib/hash/ripemd", ["npm:hash.js@1.0.2/lib/hash"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var hash = require("npm:hash.js@1.0.2/lib/hash");
  var utils = hash.utils;
  var rotl32 = utils.rotl32;
  var sum32 = utils.sum32;
  var sum32_3 = utils.sum32_3;
  var sum32_4 = utils.sum32_4;
  var BlockHash = hash.common.BlockHash;
  function RIPEMD160() {
    if (!(this instanceof RIPEMD160))
      return new RIPEMD160();
    BlockHash.call(this);
    this.h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    this.endian = 'little';
  }
  utils.inherits(RIPEMD160, BlockHash);
  exports.ripemd160 = RIPEMD160;
  RIPEMD160.blockSize = 512;
  RIPEMD160.outSize = 160;
  RIPEMD160.hmacStrength = 192;
  RIPEMD160.padLength = 64;
  RIPEMD160.prototype._update = function update(msg, start) {
    var A = this.h[0];
    var B = this.h[1];
    var C = this.h[2];
    var D = this.h[3];
    var E = this.h[4];
    var Ah = A;
    var Bh = B;
    var Ch = C;
    var Dh = D;
    var Eh = E;
    for (var j = 0; j < 80; j++) {
      var T = sum32(rotl32(sum32_4(A, f(j, B, C, D), msg[r[j] + start], K(j)), s[j]), E);
      A = E;
      E = D;
      D = rotl32(C, 10);
      C = B;
      B = T;
      T = sum32(rotl32(sum32_4(Ah, f(79 - j, Bh, Ch, Dh), msg[rh[j] + start], Kh(j)), sh[j]), Eh);
      Ah = Eh;
      Eh = Dh;
      Dh = rotl32(Ch, 10);
      Ch = Bh;
      Bh = T;
    }
    T = sum32_3(this.h[1], C, Dh);
    this.h[1] = sum32_3(this.h[2], D, Eh);
    this.h[2] = sum32_3(this.h[3], E, Ah);
    this.h[3] = sum32_3(this.h[4], A, Bh);
    this.h[4] = sum32_3(this.h[0], B, Ch);
    this.h[0] = T;
  };
  RIPEMD160.prototype._digest = function digest(enc) {
    if (enc === 'hex')
      return utils.toHex32(this.h, 'little');
    else
      return utils.split32(this.h, 'little');
  };
  function f(j, x, y, z) {
    if (j <= 15)
      return x ^ y ^ z;
    else if (j <= 31)
      return (x & y) | ((~x) & z);
    else if (j <= 47)
      return (x | (~y)) ^ z;
    else if (j <= 63)
      return (x & z) | (y & (~z));
    else
      return x ^ (y | (~z));
  }
  function K(j) {
    if (j <= 15)
      return 0x00000000;
    else if (j <= 31)
      return 0x5a827999;
    else if (j <= 47)
      return 0x6ed9eba1;
    else if (j <= 63)
      return 0x8f1bbcdc;
    else
      return 0xa953fd4e;
  }
  function Kh(j) {
    if (j <= 15)
      return 0x50a28be6;
    else if (j <= 31)
      return 0x5c4dd124;
    else if (j <= 47)
      return 0x6d703ef3;
    else if (j <= 63)
      return 0x7a6d76e9;
    else
      return 0x00000000;
  }
  var r = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13];
  var rh = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11];
  var s = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6];
  var sh = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11];
  global.define = __define;
  return module.exports;
});

System.register("npm:hash.js@1.0.2/lib/hash/hmac", ["npm:hash.js@1.0.2/lib/hash"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var hmac = exports;
  var hash = require("npm:hash.js@1.0.2/lib/hash");
  var utils = hash.utils;
  var assert = utils.assert;
  function Hmac(hash, key, enc) {
    if (!(this instanceof Hmac))
      return new Hmac(hash, key, enc);
    this.Hash = hash;
    this.blockSize = hash.blockSize / 8;
    this.outSize = hash.outSize / 8;
    this.inner = null;
    this.outer = null;
    this._init(utils.toArray(key, enc));
  }
  module.exports = Hmac;
  Hmac.prototype._init = function init(key) {
    if (key.length > this.blockSize)
      key = new this.Hash().update(key).digest();
    assert(key.length <= this.blockSize);
    for (var i = key.length; i < this.blockSize; i++)
      key.push(0);
    for (var i = 0; i < key.length; i++)
      key[i] ^= 0x36;
    this.inner = new this.Hash().update(key);
    for (var i = 0; i < key.length; i++)
      key[i] ^= 0x6a;
    this.outer = new this.Hash().update(key);
  };
  Hmac.prototype.update = function update(msg, enc) {
    this.inner.update(msg, enc);
    return this;
  };
  Hmac.prototype.digest = function digest(enc) {
    this.outer.update(this.inner.digest());
    return this.outer.digest(enc);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic/curve/base", ["npm:bn.js@1.3.0", "npm:elliptic@1.0.1/lib/elliptic"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var bn = require("npm:bn.js@1.3.0");
  var elliptic = require("npm:elliptic@1.0.1/lib/elliptic");
  var getNAF = elliptic.utils.getNAF;
  var getJSF = elliptic.utils.getJSF;
  var assert = elliptic.utils.assert;
  function BaseCurve(type, conf) {
    this.type = type;
    this.p = new bn(conf.p, 16);
    this.red = conf.prime ? bn.red(conf.prime) : bn.mont(this.p);
    this.zero = new bn(0).toRed(this.red);
    this.one = new bn(1).toRed(this.red);
    this.two = new bn(2).toRed(this.red);
    this.n = conf.n && new bn(conf.n, 16);
    this.g = conf.g && this.pointFromJSON(conf.g, conf.gRed);
    this._wnafT1 = new Array(4);
    this._wnafT2 = new Array(4);
    this._wnafT3 = new Array(4);
    this._wnafT4 = new Array(4);
  }
  module.exports = BaseCurve;
  BaseCurve.prototype.point = function point() {
    throw new Error('Not implemented');
  };
  BaseCurve.prototype.validate = function validate(point) {
    throw new Error('Not implemented');
  };
  BaseCurve.prototype._fixedNafMul = function _fixedNafMul(p, k) {
    var doubles = p._getDoubles();
    var naf = getNAF(k, 1);
    var I = (1 << (doubles.step + 1)) - (doubles.step % 2 === 0 ? 2 : 1);
    I /= 3;
    var repr = [];
    for (var j = 0; j < naf.length; j += doubles.step) {
      var nafW = 0;
      for (var k = j + doubles.step - 1; k >= j; k--)
        nafW = (nafW << 1) + naf[k];
      repr.push(nafW);
    }
    var a = this.jpoint(null, null, null);
    var b = this.jpoint(null, null, null);
    for (var i = I; i > 0; i--) {
      for (var j = 0; j < repr.length; j++) {
        var nafW = repr[j];
        if (nafW === i)
          b = b.mixedAdd(doubles.points[j]);
        else if (nafW === -i)
          b = b.mixedAdd(doubles.points[j].neg());
      }
      a = a.add(b);
    }
    return a.toP();
  };
  BaseCurve.prototype._wnafMul = function _wnafMul(p, k) {
    var w = 4;
    var nafPoints = p._getNAFPoints(w);
    w = nafPoints.wnd;
    var wnd = nafPoints.points;
    var naf = getNAF(k, w);
    var acc = this.jpoint(null, null, null);
    for (var i = naf.length - 1; i >= 0; i--) {
      for (var k = 0; i >= 0 && naf[i] === 0; i--)
        k++;
      if (i >= 0)
        k++;
      acc = acc.dblp(k);
      if (i < 0)
        break;
      var z = naf[i];
      assert(z !== 0);
      if (p.type === 'affine') {
        if (z > 0)
          acc = acc.mixedAdd(wnd[(z - 1) >> 1]);
        else
          acc = acc.mixedAdd(wnd[(-z - 1) >> 1].neg());
      } else {
        if (z > 0)
          acc = acc.add(wnd[(z - 1) >> 1]);
        else
          acc = acc.add(wnd[(-z - 1) >> 1].neg());
      }
    }
    return p.type === 'affine' ? acc.toP() : acc;
  };
  BaseCurve.prototype._wnafMulAdd = function _wnafMulAdd(defW, points, coeffs, len) {
    var wndWidth = this._wnafT1;
    var wnd = this._wnafT2;
    var naf = this._wnafT3;
    var max = 0;
    for (var i = 0; i < len; i++) {
      var p = points[i];
      var nafPoints = p._getNAFPoints(defW);
      wndWidth[i] = nafPoints.wnd;
      wnd[i] = nafPoints.points;
    }
    for (var i = len - 1; i >= 1; i -= 2) {
      var a = i - 1;
      var b = i;
      if (wndWidth[a] !== 1 || wndWidth[b] !== 1) {
        naf[a] = getNAF(coeffs[a], wndWidth[a]);
        naf[b] = getNAF(coeffs[b], wndWidth[b]);
        max = Math.max(naf[a].length, max);
        max = Math.max(naf[b].length, max);
        continue;
      }
      var comb = [points[a], null, null, points[b]];
      if (points[a].y.cmp(points[b].y) === 0) {
        comb[1] = points[a].add(points[b]);
        comb[2] = points[a].toJ().mixedAdd(points[b].neg());
      } else if (points[a].y.cmp(points[b].y.redNeg()) === 0) {
        comb[1] = points[a].toJ().mixedAdd(points[b]);
        comb[2] = points[a].add(points[b].neg());
      } else {
        comb[1] = points[a].toJ().mixedAdd(points[b]);
        comb[2] = points[a].toJ().mixedAdd(points[b].neg());
      }
      var index = [-3, -1, -5, -7, 0, 7, 5, 1, 3];
      var jsf = getJSF(coeffs[a], coeffs[b]);
      max = Math.max(jsf[0].length, max);
      naf[a] = new Array(max);
      naf[b] = new Array(max);
      for (var j = 0; j < max; j++) {
        var ja = jsf[0][j] | 0;
        var jb = jsf[1][j] | 0;
        naf[a][j] = index[(ja + 1) * 3 + (jb + 1)];
        naf[b][j] = 0;
        wnd[a] = comb;
      }
    }
    var acc = this.jpoint(null, null, null);
    var tmp = this._wnafT4;
    for (var i = max; i >= 0; i--) {
      var k = 0;
      while (i >= 0) {
        var zero = true;
        for (var j = 0; j < len; j++) {
          tmp[j] = naf[j][i] | 0;
          if (tmp[j] !== 0)
            zero = false;
        }
        if (!zero)
          break;
        k++;
        i--;
      }
      if (i >= 0)
        k++;
      acc = acc.dblp(k);
      if (i < 0)
        break;
      for (var j = 0; j < len; j++) {
        var z = tmp[j];
        var p;
        if (z === 0)
          continue;
        else if (z > 0)
          p = wnd[j][(z - 1) >> 1];
        else if (z < 0)
          p = wnd[j][(-z - 1) >> 1].neg();
        if (p.type === 'affine')
          acc = acc.mixedAdd(p);
        else
          acc = acc.add(p);
      }
    }
    for (var i = 0; i < len; i++)
      wnd[i] = null;
    return acc.toP();
  };
  BaseCurve.BasePoint = BasePoint;
  function BasePoint(curve, type) {
    this.curve = curve;
    this.type = type;
    this.precomputed = null;
  }
  BasePoint.prototype.validate = function validate() {
    return this.curve.validate(this);
  };
  BasePoint.prototype.precompute = function precompute(power, _beta) {
    if (this.precomputed)
      return this;
    var precomputed = {
      doubles: null,
      naf: null,
      beta: null
    };
    precomputed.naf = this._getNAFPoints(8);
    precomputed.doubles = this._getDoubles(4, power);
    precomputed.beta = this._getBeta();
    this.precomputed = precomputed;
    return this;
  };
  BasePoint.prototype._getDoubles = function _getDoubles(step, power) {
    if (this.precomputed && this.precomputed.doubles)
      return this.precomputed.doubles;
    var doubles = [this];
    var acc = this;
    for (var i = 0; i < power; i += step) {
      for (var j = 0; j < step; j++)
        acc = acc.dbl();
      doubles.push(acc);
    }
    return {
      step: step,
      points: doubles
    };
  };
  BasePoint.prototype._getNAFPoints = function _getNAFPoints(wnd) {
    if (this.precomputed && this.precomputed.naf)
      return this.precomputed.naf;
    var res = [this];
    var max = (1 << wnd) - 1;
    var dbl = max === 1 ? null : this.dbl();
    for (var i = 1; i < max; i++)
      res[i] = res[i - 1].add(dbl);
    return {
      wnd: wnd,
      points: res
    };
  };
  BasePoint.prototype._getBeta = function _getBeta() {
    return null;
  };
  BasePoint.prototype.dblp = function dblp(k) {
    var r = this;
    for (var i = 0; i < k; i++)
      r = r.dbl();
    return r;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic/curve/short", ["npm:elliptic@1.0.1/lib/elliptic/curve/index", "npm:elliptic@1.0.1/lib/elliptic", "npm:bn.js@1.3.0", "npm:inherits@2.0.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var curve = require("npm:elliptic@1.0.1/lib/elliptic/curve/index");
  var elliptic = require("npm:elliptic@1.0.1/lib/elliptic");
  var bn = require("npm:bn.js@1.3.0");
  var inherits = require("npm:inherits@2.0.1");
  var Base = curve.base;
  var getNAF = elliptic.utils.getNAF;
  var assert = elliptic.utils.assert;
  function ShortCurve(conf) {
    Base.call(this, 'short', conf);
    this.a = new bn(conf.a, 16).toRed(this.red);
    this.b = new bn(conf.b, 16).toRed(this.red);
    this.tinv = this.two.redInvm();
    this.zeroA = this.a.fromRed().cmpn(0) === 0;
    this.threeA = this.a.fromRed().sub(this.p).cmpn(-3) === 0;
    this.endo = this._getEndomorphism(conf);
    this._endoWnafT1 = new Array(4);
    this._endoWnafT2 = new Array(4);
  }
  inherits(ShortCurve, Base);
  module.exports = ShortCurve;
  ShortCurve.prototype._getEndomorphism = function _getEndomorphism(conf) {
    if (!this.zeroA || !this.g || !this.n || this.p.modn(3) !== 1)
      return ;
    var beta;
    var lambda;
    if (conf.beta) {
      beta = new bn(conf.beta, 16).toRed(this.red);
    } else {
      var betas = this._getEndoRoots(this.p);
      beta = betas[0].cmp(betas[1]) < 0 ? betas[0] : betas[1];
      beta = beta.toRed(this.red);
    }
    if (conf.lambda) {
      lambda = new bn(conf.lambda, 16);
    } else {
      var lambdas = this._getEndoRoots(this.n);
      if (this.g.mul(lambdas[0]).x.cmp(this.g.x.redMul(beta)) === 0) {
        lambda = lambdas[0];
      } else {
        lambda = lambdas[1];
        assert(this.g.mul(lambda).x.cmp(this.g.x.redMul(beta)) === 0);
      }
    }
    var basis;
    if (conf.basis) {
      basis = conf.basis.map(function(vec) {
        return {
          a: new bn(vec.a, 16),
          b: new bn(vec.b, 16)
        };
      });
    } else {
      basis = this._getEndoBasis(lambda);
    }
    return {
      beta: beta,
      lambda: lambda,
      basis: basis
    };
  };
  ShortCurve.prototype._getEndoRoots = function _getEndoRoots(num) {
    var red = num === this.p ? this.red : bn.mont(num);
    var tinv = new bn(2).toRed(red).redInvm();
    var ntinv = tinv.redNeg();
    var one = new bn(1).toRed(red);
    var s = new bn(3).toRed(red).redNeg().redSqrt().redMul(tinv);
    var l1 = ntinv.redAdd(s).fromRed();
    var l2 = ntinv.redSub(s).fromRed();
    return [l1, l2];
  };
  ShortCurve.prototype._getEndoBasis = function _getEndoBasis(lambda) {
    var aprxSqrt = this.n.shrn(Math.floor(this.n.bitLength() / 2));
    var u = lambda;
    var v = this.n.clone();
    var x1 = new bn(1);
    var y1 = new bn(0);
    var x2 = new bn(0);
    var y2 = new bn(1);
    var a0;
    var b0;
    var a1;
    var b1;
    var a2;
    var b2;
    var prevR;
    var i = 0;
    while (u.cmpn(0) !== 0) {
      var q = v.div(u);
      var r = v.sub(q.mul(u));
      var x = x2.sub(q.mul(x1));
      var y = y2.sub(q.mul(y1));
      if (!a1 && r.cmp(aprxSqrt) < 0) {
        a0 = prevR.neg();
        b0 = x1;
        a1 = r.neg();
        b1 = x;
      } else if (a1 && ++i === 2) {
        break;
      }
      prevR = r;
      v = u;
      u = r;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
    }
    a2 = r.neg();
    b2 = x;
    var len1 = a1.sqr().add(b1.sqr());
    var len2 = a2.sqr().add(b2.sqr());
    if (len2.cmp(len1) >= 0) {
      a2 = a0;
      b2 = b0;
    }
    if (a1.sign) {
      a1 = a1.neg();
      b1 = b1.neg();
    }
    if (a2.sign) {
      a2 = a2.neg();
      b2 = b2.neg();
    }
    return [{
      a: a1,
      b: b1
    }, {
      a: a2,
      b: b2
    }];
  };
  ShortCurve.prototype._endoSplit = function _endoSplit(k) {
    var basis = this.endo.basis;
    var v1 = basis[0];
    var v2 = basis[1];
    var c1 = v2.b.mul(k).divRound(this.n);
    var c2 = v1.b.neg().mul(k).divRound(this.n);
    var p1 = c1.mul(v1.a);
    var p2 = c2.mul(v2.a);
    var q1 = c1.mul(v1.b);
    var q2 = c2.mul(v2.b);
    var k1 = k.sub(p1).sub(p2);
    var k2 = q1.add(q2).neg();
    return {
      k1: k1,
      k2: k2
    };
  };
  ShortCurve.prototype.point = function point(x, y, isRed) {
    return new Point(this, x, y, isRed);
  };
  ShortCurve.prototype.pointFromX = function pointFromX(odd, x) {
    x = new bn(x, 16);
    if (!x.red)
      x = x.toRed(this.red);
    var y2 = x.redSqr().redMul(x).redIAdd(x.redMul(this.a)).redIAdd(this.b);
    var y = y2.redSqrt();
    var isOdd = y.fromRed().isOdd();
    if (odd && !isOdd || !odd && isOdd)
      y = y.redNeg();
    return this.point(x, y);
  };
  ShortCurve.prototype.jpoint = function jpoint(x, y, z) {
    return new JPoint(this, x, y, z);
  };
  ShortCurve.prototype.pointFromJSON = function pointFromJSON(obj, red) {
    return Point.fromJSON(this, obj, red);
  };
  ShortCurve.prototype.validate = function validate(point) {
    if (point.inf)
      return true;
    var x = point.x;
    var y = point.y;
    var ax = this.a.redMul(x);
    var rhs = x.redSqr().redMul(x).redIAdd(ax).redIAdd(this.b);
    return y.redSqr().redISub(rhs).cmpn(0) === 0;
  };
  ShortCurve.prototype._endoWnafMulAdd = function _endoWnafMulAdd(points, coeffs) {
    var npoints = this._endoWnafT1;
    var ncoeffs = this._endoWnafT2;
    for (var i = 0; i < points.length; i++) {
      var split = this._endoSplit(coeffs[i]);
      var p = points[i];
      var beta = p._getBeta();
      if (split.k1.sign) {
        split.k1.sign = !split.k1.sign;
        p = p.neg(true);
      }
      if (split.k2.sign) {
        split.k2.sign = !split.k2.sign;
        beta = beta.neg(true);
      }
      npoints[i * 2] = p;
      npoints[i * 2 + 1] = beta;
      ncoeffs[i * 2] = split.k1;
      ncoeffs[i * 2 + 1] = split.k2;
    }
    var res = this._wnafMulAdd(1, npoints, ncoeffs, i * 2);
    for (var j = 0; j < i * 2; j++) {
      npoints[j] = null;
      ncoeffs[j] = null;
    }
    return res;
  };
  function Point(curve, x, y, isRed) {
    Base.BasePoint.call(this, curve, 'affine');
    if (x === null && y === null) {
      this.x = null;
      this.y = null;
      this.inf = true;
    } else {
      this.x = new bn(x, 16);
      this.y = new bn(y, 16);
      if (isRed) {
        this.x.forceRed(this.curve.red);
        this.y.forceRed(this.curve.red);
      }
      if (!this.x.red)
        this.x = this.x.toRed(this.curve.red);
      if (!this.y.red)
        this.y = this.y.toRed(this.curve.red);
      this.inf = false;
    }
  }
  inherits(Point, Base.BasePoint);
  Point.prototype._getBeta = function _getBeta() {
    if (!this.curve.endo)
      return ;
    var pre = this.precomputed;
    if (pre && pre.beta)
      return pre.beta;
    var beta = this.curve.point(this.x.redMul(this.curve.endo.beta), this.y);
    if (pre) {
      var curve = this.curve;
      function endoMul(p) {
        return curve.point(p.x.redMul(curve.endo.beta), p.y);
      }
      pre.beta = beta;
      beta.precomputed = {
        beta: null,
        naf: pre.naf && {
          wnd: pre.naf.wnd,
          points: pre.naf.points.map(endoMul)
        },
        doubles: pre.doubles && {
          step: pre.doubles.step,
          points: pre.doubles.points.map(endoMul)
        }
      };
    }
    return beta;
  };
  Point.prototype.toJSON = function toJSON() {
    if (!this.precomputed)
      return [this.x, this.y];
    return [this.x, this.y, this.precomputed && {
      doubles: this.precomputed.doubles && {
        step: this.precomputed.doubles.step,
        points: this.precomputed.doubles.points.slice(1)
      },
      naf: this.precomputed.naf && {
        wnd: this.precomputed.naf.wnd,
        points: this.precomputed.naf.points.slice(1)
      }
    }];
  };
  Point.fromJSON = function fromJSON(curve, obj, red) {
    if (typeof obj === 'string')
      obj = JSON.parse(obj);
    var res = curve.point(obj[0], obj[1], red);
    if (!obj[2])
      return res;
    function obj2point(obj) {
      return curve.point(obj[0], obj[1], red);
    }
    var pre = obj[2];
    res.precomputed = {
      beta: null,
      doubles: pre.doubles && {
        step: pre.doubles.step,
        points: [res].concat(pre.doubles.points.map(obj2point))
      },
      naf: pre.naf && {
        wnd: pre.naf.wnd,
        points: [res].concat(pre.naf.points.map(obj2point))
      }
    };
    return res;
  };
  Point.prototype.inspect = function inspect() {
    if (this.isInfinity())
      return '<EC Point Infinity>';
    return '<EC Point x: ' + this.x.fromRed().toString(16, 2) + ' y: ' + this.y.fromRed().toString(16, 2) + '>';
  };
  Point.prototype.isInfinity = function isInfinity() {
    return this.inf;
  };
  Point.prototype.add = function add(p) {
    if (this.inf)
      return p;
    if (p.inf)
      return this;
    if (this.eq(p))
      return this.dbl();
    if (this.neg().eq(p))
      return this.curve.point(null, null);
    if (this.x.cmp(p.x) === 0)
      return this.curve.point(null, null);
    var c = this.y.redSub(p.y);
    if (c.cmpn(0) !== 0)
      c = c.redMul(this.x.redSub(p.x).redInvm());
    var nx = c.redSqr().redISub(this.x).redISub(p.x);
    var ny = c.redMul(this.x.redSub(nx)).redISub(this.y);
    return this.curve.point(nx, ny);
  };
  Point.prototype.dbl = function dbl() {
    if (this.inf)
      return this;
    var ys1 = this.y.redAdd(this.y);
    if (ys1.cmpn(0) === 0)
      return this.curve.point(null, null);
    var a = this.curve.a;
    var x2 = this.x.redSqr();
    var dyinv = ys1.redInvm();
    var c = x2.redAdd(x2).redIAdd(x2).redIAdd(a).redMul(dyinv);
    var nx = c.redSqr().redISub(this.x.redAdd(this.x));
    var ny = c.redMul(this.x.redSub(nx)).redISub(this.y);
    return this.curve.point(nx, ny);
  };
  Point.prototype.getX = function getX() {
    return this.x.fromRed();
  };
  Point.prototype.getY = function getY() {
    return this.y.fromRed();
  };
  Point.prototype.mul = function mul(k) {
    k = new bn(k, 16);
    if (this.precomputed && this.precomputed.doubles)
      return this.curve._fixedNafMul(this, k);
    else if (this.curve.endo)
      return this.curve._endoWnafMulAdd([this], [k]);
    else
      return this.curve._wnafMul(this, k);
  };
  Point.prototype.mulAdd = function mulAdd(k1, p2, k2) {
    var points = [this, p2];
    var coeffs = [k1, k2];
    if (this.curve.endo)
      return this.curve._endoWnafMulAdd(points, coeffs);
    else
      return this.curve._wnafMulAdd(1, points, coeffs, 2);
  };
  Point.prototype.eq = function eq(p) {
    return this === p || this.inf === p.inf && (this.inf || this.x.cmp(p.x) === 0 && this.y.cmp(p.y) === 0);
  };
  Point.prototype.neg = function neg(_precompute) {
    if (this.inf)
      return this;
    var res = this.curve.point(this.x, this.y.redNeg());
    if (_precompute && this.precomputed) {
      var pre = this.precomputed;
      function negate(p) {
        return p.neg();
      }
      res.precomputed = {
        naf: pre.naf && {
          wnd: pre.naf.wnd,
          points: pre.naf.points.map(negate)
        },
        doubles: pre.doubles && {
          step: pre.doubles.step,
          points: pre.doubles.points.map(negate)
        }
      };
    }
    return res;
  };
  Point.prototype.toJ = function toJ() {
    if (this.inf)
      return this.curve.jpoint(null, null, null);
    var res = this.curve.jpoint(this.x, this.y, this.curve.one);
    return res;
  };
  function JPoint(curve, x, y, z) {
    Base.BasePoint.call(this, curve, 'jacobian');
    if (x === null && y === null && z === null) {
      this.x = this.curve.one;
      this.y = this.curve.one;
      this.z = new bn(0);
    } else {
      this.x = new bn(x, 16);
      this.y = new bn(y, 16);
      this.z = new bn(z, 16);
    }
    if (!this.x.red)
      this.x = this.x.toRed(this.curve.red);
    if (!this.y.red)
      this.y = this.y.toRed(this.curve.red);
    if (!this.z.red)
      this.z = this.z.toRed(this.curve.red);
    this.zOne = this.z === this.curve.one;
  }
  inherits(JPoint, Base.BasePoint);
  JPoint.prototype.toP = function toP() {
    if (this.isInfinity())
      return this.curve.point(null, null);
    var zinv = this.z.redInvm();
    var zinv2 = zinv.redSqr();
    var ax = this.x.redMul(zinv2);
    var ay = this.y.redMul(zinv2).redMul(zinv);
    return this.curve.point(ax, ay);
  };
  JPoint.prototype.neg = function neg() {
    return this.curve.jpoint(this.x, this.y.redNeg(), this.z);
  };
  JPoint.prototype.add = function add(p) {
    if (this.isInfinity())
      return p;
    if (p.isInfinity())
      return this;
    var pz2 = p.z.redSqr();
    var z2 = this.z.redSqr();
    var u1 = this.x.redMul(pz2);
    var u2 = p.x.redMul(z2);
    var s1 = this.y.redMul(pz2.redMul(p.z));
    var s2 = p.y.redMul(z2.redMul(this.z));
    var h = u1.redSub(u2);
    var r = s1.redSub(s2);
    if (h.cmpn(0) === 0) {
      if (r.cmpn(0) !== 0)
        return this.curve.jpoint(null, null, null);
      else
        return this.dbl();
    }
    var h2 = h.redSqr();
    var h3 = h2.redMul(h);
    var v = u1.redMul(h2);
    var nx = r.redSqr().redIAdd(h3).redISub(v).redISub(v);
    var ny = r.redMul(v.redISub(nx)).redISub(s1.redMul(h3));
    var nz = this.z.redMul(p.z).redMul(h);
    return this.curve.jpoint(nx, ny, nz);
  };
  JPoint.prototype.mixedAdd = function mixedAdd(p) {
    if (this.isInfinity())
      return p.toJ();
    if (p.isInfinity())
      return this;
    var z2 = this.z.redSqr();
    var u1 = this.x;
    var u2 = p.x.redMul(z2);
    var s1 = this.y;
    var s2 = p.y.redMul(z2).redMul(this.z);
    var h = u1.redSub(u2);
    var r = s1.redSub(s2);
    if (h.cmpn(0) === 0) {
      if (r.cmpn(0) !== 0)
        return this.curve.jpoint(null, null, null);
      else
        return this.dbl();
    }
    var h2 = h.redSqr();
    var h3 = h2.redMul(h);
    var v = u1.redMul(h2);
    var nx = r.redSqr().redIAdd(h3).redISub(v).redISub(v);
    var ny = r.redMul(v.redISub(nx)).redISub(s1.redMul(h3));
    var nz = this.z.redMul(h);
    return this.curve.jpoint(nx, ny, nz);
  };
  JPoint.prototype.dblp = function dblp(pow) {
    if (pow === 0)
      return this;
    if (this.isInfinity())
      return this;
    if (!pow)
      return this.dbl();
    if (this.curve.zeroA || this.curve.threeA) {
      var r = this;
      for (var i = 0; i < pow; i++)
        r = r.dbl();
      return r;
    }
    var a = this.curve.a;
    var tinv = this.curve.tinv;
    var jx = this.x;
    var jy = this.y;
    var jz = this.z;
    var jz4 = jz.redSqr().redSqr();
    var jyd = jy.redAdd(jy);
    for (var i = 0; i < pow; i++) {
      var jx2 = jx.redSqr();
      var jyd2 = jyd.redSqr();
      var jyd4 = jyd2.redSqr();
      var c = jx2.redAdd(jx2).redIAdd(jx2).redIAdd(a.redMul(jz4));
      var t1 = jx.redMul(jyd2);
      var nx = c.redSqr().redISub(t1.redAdd(t1));
      var t2 = t1.redISub(nx);
      var dny = c.redMul(t2);
      dny = dny.redIAdd(dny).redISub(jyd4);
      var nz = jyd.redMul(jz);
      if (i + 1 < pow)
        jz4 = jz4.redMul(jyd4);
      jx = nx;
      jz = nz;
      jyd = dny;
    }
    return this.curve.jpoint(jx, jyd.redMul(tinv), jz);
  };
  JPoint.prototype.dbl = function dbl() {
    if (this.isInfinity())
      return this;
    if (this.curve.zeroA)
      return this._zeroDbl();
    else if (this.curve.threeA)
      return this._threeDbl();
    else
      return this._dbl();
  };
  JPoint.prototype._zeroDbl = function _zeroDbl() {
    if (this.zOne) {
      var xx = this.x.redSqr();
      var yy = this.y.redSqr();
      var yyyy = yy.redSqr();
      var s = this.x.redAdd(yy).redSqr().redISub(xx).redISub(yyyy);
      s = s.redIAdd(s);
      var m = xx.redAdd(xx).redIAdd(xx);
      var t = m.redSqr().redISub(s).redISub(s);
      var yyyy8 = yyyy.redIAdd(yyyy);
      yyyy8 = yyyy8.redIAdd(yyyy8);
      yyyy8 = yyyy8.redIAdd(yyyy8);
      var nx = t;
      var ny = m.redMul(s.redISub(t)).redISub(yyyy8);
      var nz = this.y.redAdd(this.y);
    } else {
      var a = this.x.redSqr();
      var b = this.y.redSqr();
      var c = b.redSqr();
      var d = this.x.redAdd(b).redSqr().redISub(a).redISub(c);
      d = d.redIAdd(d);
      var e = a.redAdd(a).redIAdd(a);
      var f = e.redSqr();
      var c8 = c.redIAdd(c);
      c8 = c8.redIAdd(c8);
      c8 = c8.redIAdd(c8);
      var nx = f.redISub(d).redISub(d);
      var ny = e.redMul(d.redISub(nx)).redISub(c8);
      var nz = this.y.redMul(this.z);
      nz = nz.redIAdd(nz);
    }
    return this.curve.jpoint(nx, ny, nz);
  };
  JPoint.prototype._threeDbl = function _threeDbl() {
    if (this.zOne) {
      var xx = this.x.redSqr();
      var yy = this.y.redSqr();
      var yyyy = yy.redSqr();
      var s = this.x.redAdd(yy).redSqr().redISub(xx).redISub(yyyy);
      s = s.redIAdd(s);
      var m = xx.redAdd(xx).redIAdd(xx).redIAdd(this.curve.a);
      var t = m.redSqr().redISub(s).redISub(s);
      var nx = t;
      var yyyy8 = yyyy.redIAdd(yyyy);
      yyyy8 = yyyy8.redIAdd(yyyy8);
      yyyy8 = yyyy8.redIAdd(yyyy8);
      var ny = m.redMul(s.redISub(t)).redISub(yyyy8);
      var nz = this.y.redAdd(this.y);
    } else {
      var delta = this.z.redSqr();
      var gamma = this.y.redSqr();
      var beta = this.x.redMul(gamma);
      var alpha = this.x.redSub(delta).redMul(this.x.redAdd(delta));
      alpha = alpha.redAdd(alpha).redIAdd(alpha);
      var beta4 = beta.redIAdd(beta);
      beta4 = beta4.redIAdd(beta4);
      var beta8 = beta4.redAdd(beta4);
      var nx = alpha.redSqr().redISub(beta8);
      var nz = this.y.redAdd(this.z).redSqr().redISub(gamma).redISub(delta);
      var ggamma8 = gamma.redSqr();
      ggamma8 = ggamma8.redIAdd(ggamma8);
      ggamma8 = ggamma8.redIAdd(ggamma8);
      ggamma8 = ggamma8.redIAdd(ggamma8);
      var ny = alpha.redMul(beta4.redISub(nx)).redISub(ggamma8);
    }
    return this.curve.jpoint(nx, ny, nz);
  };
  JPoint.prototype._dbl = function _dbl() {
    var a = this.curve.a;
    var tinv = this.curve.tinv;
    var jx = this.x;
    var jy = this.y;
    var jz = this.z;
    var jz4 = jz.redSqr().redSqr();
    var jx2 = jx.redSqr();
    var jy2 = jy.redSqr();
    var c = jx2.redAdd(jx2).redIAdd(jx2).redIAdd(a.redMul(jz4));
    var jxd4 = jx.redAdd(jx);
    jxd4 = jxd4.redIAdd(jxd4);
    var t1 = jxd4.redMul(jy2);
    var nx = c.redSqr().redISub(t1.redAdd(t1));
    var t2 = t1.redISub(nx);
    var jyd8 = jy2.redSqr();
    jyd8 = jyd8.redIAdd(jyd8);
    jyd8 = jyd8.redIAdd(jyd8);
    jyd8 = jyd8.redIAdd(jyd8);
    var ny = c.redMul(t2).redISub(jyd8);
    var nz = jy.redAdd(jy).redMul(jz);
    return this.curve.jpoint(nx, ny, nz);
  };
  JPoint.prototype.trpl = function trpl() {
    if (!this.curve.zeroA)
      return this.dbl().add(this);
    var xx = this.x.redSqr();
    var yy = this.y.redSqr();
    var zz = this.z.redSqr();
    var yyyy = yy.redSqr();
    var m = xx.redAdd(xx).redIAdd(xx);
    var mm = m.redSqr();
    var e = this.x.redAdd(yy).redSqr().redISub(xx).redISub(yyyy);
    e = e.redIAdd(e);
    e = e.redAdd(e).redIAdd(e);
    e = e.redISub(mm);
    var ee = e.redSqr();
    var t = yyyy.redIAdd(yyyy);
    t = t.redIAdd(t);
    t = t.redIAdd(t);
    t = t.redIAdd(t);
    var u = m.redIAdd(e).redSqr().redISub(mm).redISub(ee).redISub(t);
    var yyu4 = yy.redMul(u);
    yyu4 = yyu4.redIAdd(yyu4);
    yyu4 = yyu4.redIAdd(yyu4);
    var nx = this.x.redMul(ee).redISub(yyu4);
    nx = nx.redIAdd(nx);
    nx = nx.redIAdd(nx);
    var ny = this.y.redMul(u.redMul(t.redISub(u)).redISub(e.redMul(ee)));
    ny = ny.redIAdd(ny);
    ny = ny.redIAdd(ny);
    ny = ny.redIAdd(ny);
    var nz = this.z.redAdd(e).redSqr().redISub(zz).redISub(ee);
    return this.curve.jpoint(nx, ny, nz);
  };
  JPoint.prototype.mul = function mul(k, kbase) {
    k = new bn(k, kbase);
    return this.curve._wnafMul(this, k);
  };
  JPoint.prototype.eq = function eq(p) {
    if (p.type === 'affine')
      return this.eq(p.toJ());
    if (this === p)
      return true;
    var z2 = this.z.redSqr();
    var pz2 = p.z.redSqr();
    if (this.x.redMul(pz2).redISub(p.x.redMul(z2)).cmpn(0) !== 0)
      return false;
    var z3 = z2.redMul(this.z);
    var pz3 = pz2.redMul(p.z);
    return this.y.redMul(pz3).redISub(p.y.redMul(z3)).cmpn(0) === 0;
  };
  JPoint.prototype.inspect = function inspect() {
    if (this.isInfinity())
      return '<EC JPoint Infinity>';
    return '<EC JPoint x: ' + this.x.toString(16, 2) + ' y: ' + this.y.toString(16, 2) + ' z: ' + this.z.toString(16, 2) + '>';
  };
  JPoint.prototype.isInfinity = function isInfinity() {
    return this.z.cmpn(0) === 0;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic/curve/mont", ["npm:elliptic@1.0.1/lib/elliptic/curve/index", "npm:elliptic@1.0.1/lib/elliptic", "npm:bn.js@1.3.0", "npm:inherits@2.0.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var curve = require("npm:elliptic@1.0.1/lib/elliptic/curve/index");
  var elliptic = require("npm:elliptic@1.0.1/lib/elliptic");
  var bn = require("npm:bn.js@1.3.0");
  var inherits = require("npm:inherits@2.0.1");
  var Base = curve.base;
  var getNAF = elliptic.utils.getNAF;
  var assert = elliptic.utils.assert;
  function MontCurve(conf) {
    Base.call(this, 'mont', conf);
    this.a = new bn(conf.a, 16).toRed(this.red);
    this.b = new bn(conf.b, 16).toRed(this.red);
    this.i4 = new bn(4).toRed(this.red).redInvm();
    this.two = new bn(2).toRed(this.red);
    this.a24 = this.i4.redMul(this.a.redAdd(this.two));
  }
  inherits(MontCurve, Base);
  module.exports = MontCurve;
  MontCurve.prototype.point = function point(x, z) {
    return new Point(this, x, z);
  };
  MontCurve.prototype.pointFromJSON = function pointFromJSON(obj) {
    return Point.fromJSON(this, obj);
  };
  MontCurve.prototype.validate = function validate(point) {
    var x = point.normalize().x;
    var x2 = x.redSqr();
    var rhs = x2.redMul(x).redAdd(x2.redMul(this.a)).redAdd(x);
    var y = rhs.redSqrt();
    return y.redSqr().cmp(rhs) === 0;
  };
  function Point(curve, x, z) {
    Base.BasePoint.call(this, curve, 'projective');
    if (x === null && z === null) {
      this.x = this.curve.one;
      this.z = this.curve.zero;
    } else {
      this.x = new bn(x, 16);
      this.z = new bn(z, 16);
      if (!this.x.red)
        this.x = this.x.toRed(this.curve.red);
      if (!this.z.red)
        this.z = this.z.toRed(this.curve.red);
    }
  }
  inherits(Point, Base.BasePoint);
  Point.prototype.precompute = function precompute() {};
  Point.fromJSON = function fromJSON(curve, obj) {
    return new Point(curve, obj[0], obj[1] || curve.one);
  };
  Point.prototype.inspect = function inspect() {
    if (this.isInfinity())
      return '<EC Point Infinity>';
    return '<EC Point x: ' + this.x.fromRed().toString(16, 2) + ' z: ' + this.z.fromRed().toString(16, 2) + '>';
  };
  Point.prototype.isInfinity = function isInfinity() {
    return this.z.cmpn(0) === 0;
  };
  Point.prototype.dbl = function dbl() {
    var a = this.x.redAdd(this.z);
    var aa = a.redSqr();
    var b = this.x.redSub(this.z);
    var bb = b.redSqr();
    var c = aa.redSub(bb);
    var nx = aa.redMul(bb);
    var nz = c.redMul(bb.redAdd(this.curve.a24.redMul(c)));
    return this.curve.point(nx, nz);
  };
  Point.prototype.add = function add(p) {
    throw new Error('Not supported on Montgomery curve');
  };
  Point.prototype.diffAdd = function diffAdd(p, diff) {
    var a = this.x.redAdd(this.z);
    var b = this.x.redSub(this.z);
    var c = p.x.redAdd(p.z);
    var d = p.x.redSub(p.z);
    var da = d.redMul(a);
    var cb = c.redMul(b);
    var nx = diff.z.redMul(da.redAdd(cb).redSqr());
    var nz = diff.x.redMul(da.redISub(cb).redSqr());
    return this.curve.point(nx, nz);
  };
  Point.prototype.mul = function mul(k) {
    var t = k.clone();
    var a = this;
    var b = this.curve.point(null, null);
    var c = this;
    for (var bits = []; t.cmpn(0) !== 0; t.ishrn(1))
      bits.push(t.andln(1));
    for (var i = bits.length - 1; i >= 0; i--) {
      if (bits[i] === 0) {
        a = a.diffAdd(b, c);
        b = b.dbl();
      } else {
        b = a.diffAdd(b, c);
        a = a.dbl();
      }
    }
    return b;
  };
  Point.prototype.mulAdd = function mulAdd() {
    throw new Error('Not supported on Montgomery curve');
  };
  Point.prototype.normalize = function normalize() {
    this.x = this.x.redMul(this.z.redInvm());
    this.z = this.curve.one;
    return this;
  };
  Point.prototype.getX = function getX() {
    this.normalize();
    return this.x.fromRed();
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic/curve/edwards", ["npm:elliptic@1.0.1/lib/elliptic/curve/index", "npm:elliptic@1.0.1/lib/elliptic", "npm:bn.js@1.3.0", "npm:inherits@2.0.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var curve = require("npm:elliptic@1.0.1/lib/elliptic/curve/index");
  var elliptic = require("npm:elliptic@1.0.1/lib/elliptic");
  var bn = require("npm:bn.js@1.3.0");
  var inherits = require("npm:inherits@2.0.1");
  var Base = curve.base;
  var getNAF = elliptic.utils.getNAF;
  var assert = elliptic.utils.assert;
  function EdwardsCurve(conf) {
    this.twisted = conf.a != 1;
    this.mOneA = this.twisted && conf.a == -1;
    this.extended = this.mOneA;
    Base.call(this, 'mont', conf);
    this.a = new bn(conf.a, 16).mod(this.red.m).toRed(this.red);
    this.c = new bn(conf.c, 16).toRed(this.red);
    this.c2 = this.c.redSqr();
    this.d = new bn(conf.d, 16).toRed(this.red);
    this.dd = this.d.redAdd(this.d);
    assert(!this.twisted || this.c.fromRed().cmpn(1) === 0);
    this.oneC = conf.c == 1;
  }
  inherits(EdwardsCurve, Base);
  module.exports = EdwardsCurve;
  EdwardsCurve.prototype._mulA = function _mulA(num) {
    if (this.mOneA)
      return num.redNeg();
    else
      return this.a.redMul(num);
  };
  EdwardsCurve.prototype._mulC = function _mulC(num) {
    if (this.oneC)
      return num;
    else
      return this.c.redMul(num);
  };
  EdwardsCurve.prototype.point = function point(x, y, z, t) {
    return new Point(this, x, y, z, t);
  };
  EdwardsCurve.prototype.jpoint = function jpoint(x, y, z, t) {
    return this.point(x, y, z, t);
  };
  EdwardsCurve.prototype.pointFromJSON = function pointFromJSON(obj) {
    return Point.fromJSON(this, obj);
  };
  EdwardsCurve.prototype.pointFromX = function pointFromX(odd, x) {
    x = new bn(x, 16);
    if (!x.red)
      x = x.toRed(this.red);
    var x2 = x.redSqr();
    var rhs = this.c2.redSub(this.a.redMul(x2));
    var lhs = this.one.redSub(this.c2.redMul(this.d).redMul(x2));
    var y = rhs.redMul(lhs.redInvm()).redSqrt();
    var isOdd = y.fromRed().isOdd();
    if (odd && !isOdd || !odd && isOdd)
      y = y.redNeg();
    return this.point(x, y, curve.one);
  };
  EdwardsCurve.prototype.validate = function validate(point) {
    if (point.isInfinity())
      return true;
    point.normalize();
    var x2 = point.x.redSqr();
    var y2 = point.y.redSqr();
    var lhs = x2.redMul(this.a).redAdd(y2);
    var rhs = this.c2.redMul(this.one.redAdd(this.d.redMul(x2).redMul(y2)));
    return lhs.cmp(rhs) === 0;
  };
  function Point(curve, x, y, z, t) {
    Base.BasePoint.call(this, curve, 'projective');
    if (x === null && y === null && z === null) {
      this.x = this.curve.zero;
      this.y = this.curve.one;
      this.z = this.curve.one;
      this.t = this.curve.zero;
      this.zOne = true;
    } else {
      this.x = new bn(x, 16);
      this.y = new bn(y, 16);
      this.z = z ? new bn(z, 16) : this.curve.one;
      this.t = t && new bn(t, 16);
      if (!this.x.red)
        this.x = this.x.toRed(this.curve.red);
      if (!this.y.red)
        this.y = this.y.toRed(this.curve.red);
      if (!this.z.red)
        this.z = this.z.toRed(this.curve.red);
      if (this.t && !this.t.red)
        this.t = this.t.toRed(this.curve.red);
      this.zOne = this.z === this.curve.one;
      if (this.curve.extended && !this.t) {
        this.t = this.x.redMul(this.y);
        if (!this.zOne)
          this.t = this.t.redMul(this.z.redInvm());
      }
    }
  }
  inherits(Point, Base.BasePoint);
  Point.fromJSON = function fromJSON(curve, obj) {
    return new Point(curve, obj[0], obj[1], obj[2]);
  };
  Point.prototype.inspect = function inspect() {
    if (this.isInfinity())
      return '<EC Point Infinity>';
    return '<EC Point x: ' + this.x.fromRed().toString(16, 2) + ' y: ' + this.y.fromRed().toString(16, 2) + ' z: ' + this.z.fromRed().toString(16, 2) + '>';
  };
  Point.prototype.isInfinity = function isInfinity() {
    return this.x.cmpn(0) === 0 && this.y.cmp(this.z) === 0;
  };
  Point.prototype._extDbl = function _extDbl() {
    var a = this.x.redSqr();
    var b = this.y.redSqr();
    var c = this.z.redSqr();
    c = c.redIAdd(c);
    var d = this.curve._mulA(a);
    var e = this.x.redAdd(this.y).redSqr().redISub(a).redISub(b);
    var g = d.redAdd(b);
    var f = g.redSub(c);
    var h = d.redSub(b);
    var nx = e.redMul(f);
    var ny = g.redMul(h);
    var nt = e.redMul(h);
    var nz = f.redMul(g);
    return this.curve.point(nx, ny, nz, nt);
  };
  Point.prototype._projDbl = function _projDbl() {
    var b = this.x.redAdd(this.y).redSqr();
    var c = this.x.redSqr();
    var d = this.y.redSqr();
    if (this.curve.twisted) {
      var e = this.curve._mulA(c);
      var f = e.redAdd(d);
      if (this.zOne) {
        var nx = b.redSub(c).redSub(d).redMul(f.redSub(this.curve.two));
        var ny = f.redMul(e.redSub(d));
        var nz = f.redSqr().redSub(f).redSub(f);
      } else {
        var h = this.z.redSqr();
        var j = f.redSub(h).redISub(h);
        var nx = b.redSub(c).redISub(d).redMul(j);
        var ny = f.redMul(e.redSub(d));
        var nz = f.redMul(j);
      }
    } else {
      var e = c.redAdd(d);
      var h = this.curve._mulC(redMul(this.z)).redSqr();
      var j = e.redSub(h).redSub(h);
      var nx = this.curve._mulC(b.redISub(e)).redMul(j);
      var ny = this.curve._mulC(e).redMul(c.redISub(d));
      var nz = e.redMul(j);
    }
    return this.curve.point(nx, ny, nz);
  };
  Point.prototype.dbl = function dbl() {
    if (this.isInfinity())
      return this;
    if (this.curve.extended)
      return this._extDbl();
    else
      return this._projDbl();
  };
  Point.prototype._extAdd = function _extAdd(p) {
    var a = this.y.redSub(this.x).redMul(p.y.redSub(p.x));
    var b = this.y.redAdd(this.x).redMul(p.y.redAdd(p.x));
    var c = this.t.redMul(this.curve.dd).redMul(p.t);
    var d = this.z.redMul(p.z.redAdd(p.z));
    var e = b.redSub(a);
    var f = d.redSub(c);
    var g = d.redAdd(c);
    var h = b.redAdd(a);
    var nx = e.redMul(f);
    var ny = g.redMul(h);
    var nt = e.redMul(h);
    var nz = f.redMul(g);
    return this.curve.point(nx, ny, nz, nt);
  };
  Point.prototype._projAdd = function _projAdd(p) {
    var a = this.z.redMul(p.z);
    var b = a.redSqr();
    var c = this.x.redMul(p.x);
    var d = this.y.redMul(p.y);
    var e = this.curve.d.redMul(c).redMul(d);
    var f = b.redSub(e);
    var g = b.redAdd(e);
    var tmp = this.x.redAdd(this.y).redMul(p.x.redAdd(p.y)).redISub(c).redISub(d);
    var nx = a.redMul(f).redMul(tmp);
    if (this.curve.twisted) {
      var ny = a.redMul(g).redMul(d.redSub(this.curve._mulA(c)));
      var nz = f.redMul(g);
    } else {
      var ny = a.redMul(g).redMul(d.redSub(c));
      var nz = this.curve._mulC(f).redMul(g);
    }
    return this.curve.point(nx, ny, nz);
  };
  Point.prototype.add = function add(p) {
    if (this.isInfinity())
      return p;
    if (p.isInfinity())
      return this;
    if (this.curve.extended)
      return this._extAdd(p);
    else
      return this._projAdd(p);
  };
  Point.prototype.mul = function mul(k) {
    if (this.precomputed && this.precomputed.doubles)
      return this.curve._fixedNafMul(this, k);
    else
      return this.curve._wnafMul(this, k);
  };
  Point.prototype.mulAdd = function mulAdd(k1, p, k2) {
    return this.curve._wnafMulAdd(1, [this, p], [k1, k2], 2);
  };
  Point.prototype.normalize = function normalize() {
    if (this.zOne)
      return this;
    var zi = this.z.redInvm();
    this.x = this.x.redMul(zi);
    this.y = this.y.redMul(zi);
    if (this.t)
      this.t = this.t.redMul(zi);
    this.z = this.curve.one;
    this.zOne = true;
    return this;
  };
  Point.prototype.neg = function neg() {
    return this.curve.point(this.x.redNeg(), this.y, this.z, this.t && this.t.redNeg());
  };
  Point.prototype.getX = function getX() {
    this.normalize();
    return this.x.fromRed();
  };
  Point.prototype.getY = function getY() {
    this.normalize();
    return this.y.fromRed();
  };
  Point.prototype.toP = Point.prototype.normalize;
  Point.prototype.mixedAdd = Point.prototype.add;
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic/curves", ["npm:hash.js@1.0.2", "npm:bn.js@1.3.0", "npm:elliptic@1.0.1/lib/elliptic"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var curves = exports;
  var hash = require("npm:hash.js@1.0.2");
  var bn = require("npm:bn.js@1.3.0");
  var elliptic = require("npm:elliptic@1.0.1/lib/elliptic");
  var assert = elliptic.utils.assert;
  function PresetCurve(options) {
    if (options.type === 'short')
      this.curve = new elliptic.curve.short(options);
    else if (options.type === 'edwards')
      this.curve = new elliptic.curve.edwards(options);
    else
      this.curve = new elliptic.curve.mont(options);
    this.g = this.curve.g;
    this.n = this.curve.n;
    this.hash = options.hash;
    assert(this.g.validate(), 'Invalid curve');
    assert(this.g.mul(this.n).isInfinity(), 'Invalid curve, G*N != O');
  }
  curves.PresetCurve = PresetCurve;
  function defineCurve(name, options) {
    Object.defineProperty(curves, name, {
      configurable: true,
      enumerable: true,
      get: function() {
        var curve = new PresetCurve(options);
        Object.defineProperty(curves, name, {
          configurable: true,
          enumerable: true,
          value: curve
        });
        return curve;
      }
    });
  }
  defineCurve('p192', {
    type: 'short',
    prime: 'p192',
    p: 'ffffffff ffffffff ffffffff fffffffe ffffffff ffffffff',
    a: 'ffffffff ffffffff ffffffff fffffffe ffffffff fffffffc',
    b: '64210519 e59c80e7 0fa7e9ab 72243049 feb8deec c146b9b1',
    n: 'ffffffff ffffffff ffffffff 99def836 146bc9b1 b4d22831',
    hash: hash.sha256,
    gRed: false,
    g: ['188da80e b03090f6 7cbf20eb 43a18800 f4ff0afd 82ff1012', '07192b95 ffc8da78 631011ed 6b24cdd5 73f977a1 1e794811']
  });
  defineCurve('p224', {
    type: 'short',
    prime: 'p224',
    p: 'ffffffff ffffffff ffffffff ffffffff 00000000 00000000 00000001',
    a: 'ffffffff ffffffff ffffffff fffffffe ffffffff ffffffff fffffffe',
    b: 'b4050a85 0c04b3ab f5413256 5044b0b7 d7bfd8ba 270b3943 2355ffb4',
    n: 'ffffffff ffffffff ffffffff ffff16a2 e0b8f03e 13dd2945 5c5c2a3d',
    hash: hash.sha256,
    gRed: false,
    g: ['b70e0cbd 6bb4bf7f 321390b9 4a03c1d3 56c21122 343280d6 115c1d21', 'bd376388 b5f723fb 4c22dfe6 cd4375a0 5a074764 44d58199 85007e34']
  });
  defineCurve('p256', {
    type: 'short',
    prime: null,
    p: 'ffffffff 00000001 00000000 00000000 00000000 ffffffff ffffffff ffffffff',
    a: 'ffffffff 00000001 00000000 00000000 00000000 ffffffff ffffffff fffffffc',
    b: '5ac635d8 aa3a93e7 b3ebbd55 769886bc 651d06b0 cc53b0f6 3bce3c3e 27d2604b',
    n: 'ffffffff 00000000 ffffffff ffffffff bce6faad a7179e84 f3b9cac2 fc632551',
    hash: hash.sha256,
    gRed: false,
    g: ['6b17d1f2 e12c4247 f8bce6e5 63a440f2 77037d81 2deb33a0 f4a13945 d898c296', '4fe342e2 fe1a7f9b 8ee7eb4a 7c0f9e16 2bce3357 6b315ece cbb64068 37bf51f5']
  });
  defineCurve('curve25519', {
    type: 'mont',
    prime: 'p25519',
    p: '7fffffffffffffff ffffffffffffffff ffffffffffffffff ffffffffffffffed',
    a: '76d06',
    b: '0',
    n: '1000000000000000 0000000000000000 14def9dea2f79cd6 5812631a5cf5d3ed',
    hash: hash.sha256,
    gRed: false,
    g: ['9']
  });
  defineCurve('ed25519', {
    type: 'edwards',
    prime: 'p25519',
    p: '7fffffffffffffff ffffffffffffffff ffffffffffffffff ffffffffffffffed',
    a: '-1',
    c: '1',
    d: '52036cee2b6ffe73 8cc740797779e898 00700a4d4141d8ab 75eb4dca135978a3',
    n: '1000000000000000 0000000000000000 14def9dea2f79cd6 5812631a5cf5d3ed',
    hash: hash.sha256,
    gRed: false,
    g: ['216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a', '6666666666666666666666666666666666666666666666666666666666666658']
  });
  defineCurve('secp256k1', {
    type: 'short',
    prime: 'k256',
    p: 'ffffffff ffffffff ffffffff ffffffff ffffffff ffffffff fffffffe fffffc2f',
    a: '0',
    b: '7',
    n: 'ffffffff ffffffff ffffffff fffffffe baaedce6 af48a03b bfd25e8c d0364141',
    h: '1',
    hash: hash.sha256,
    beta: '7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee',
    lambda: '5363ad4cc05c30e0a5261c028812645a122e22ea20816678df02967c1b23bd72',
    basis: [{
      a: '3086d221a7d46bcde86c90e49284eb15',
      b: '-e4437ed6010e88286f547fa90abfe4c3'
    }, {
      a: '114ca50f7a8e2f3f657c1108d9d44cfd8',
      b: '3086d221a7d46bcde86c90e49284eb15'
    }],
    gRed: false,
    g: ['79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8', {
      'doubles': {
        'step': 4,
        'points': [['e60fce93b59e9ec53011aabc21c23e97b2a31369b87a5ae9c44ee89e2a6dec0a', 'f7e3507399e595929db99f34f57937101296891e44d23f0be1f32cce69616821'], ['8282263212c609d9ea2a6e3e172de238d8c39cabd5ac1ca10646e23fd5f51508', '11f8a8098557dfe45e8256e830b60ace62d613ac2f7b17bed31b6eaff6e26caf'], ['175e159f728b865a72f99cc6c6fc846de0b93833fd2222ed73fce5b551e5b739', 'd3506e0d9e3c79eba4ef97a51ff71f5eacb5955add24345c6efa6ffee9fed695'], ['363d90d447b00c9c99ceac05b6262ee053441c7e55552ffe526bad8f83ff4640', '4e273adfc732221953b445397f3363145b9a89008199ecb62003c7f3bee9de9'], ['8b4b5f165df3c2be8c6244b5b745638843e4a781a15bcd1b69f79a55dffdf80c', '4aad0a6f68d308b4b3fbd7813ab0da04f9e336546162ee56b3eff0c65fd4fd36'], ['723cbaa6e5db996d6bf771c00bd548c7b700dbffa6c0e77bcb6115925232fcda', '96e867b5595cc498a921137488824d6e2660a0653779494801dc069d9eb39f5f'], ['eebfa4d493bebf98ba5feec812c2d3b50947961237a919839a533eca0e7dd7fa', '5d9a8ca3970ef0f269ee7edaf178089d9ae4cdc3a711f712ddfd4fdae1de8999'], ['100f44da696e71672791d0a09b7bde459f1215a29b3c03bfefd7835b39a48db0', 'cdd9e13192a00b772ec8f3300c090666b7ff4a18ff5195ac0fbd5cd62bc65a09'], ['e1031be262c7ed1b1dc9227a4a04c017a77f8d4464f3b3852c8acde6e534fd2d', '9d7061928940405e6bb6a4176597535af292dd419e1ced79a44f18f29456a00d'], ['feea6cae46d55b530ac2839f143bd7ec5cf8b266a41d6af52d5e688d9094696d', 'e57c6b6c97dce1bab06e4e12bf3ecd5c981c8957cc41442d3155debf18090088'], ['da67a91d91049cdcb367be4be6ffca3cfeed657d808583de33fa978bc1ec6cb1', '9bacaa35481642bc41f463f7ec9780e5dec7adc508f740a17e9ea8e27a68be1d'], ['53904faa0b334cdda6e000935ef22151ec08d0f7bb11069f57545ccc1a37b7c0', '5bc087d0bc80106d88c9eccac20d3c1c13999981e14434699dcb096b022771c8'], ['8e7bcd0bd35983a7719cca7764ca906779b53a043a9b8bcaeff959f43ad86047', '10b7770b2a3da4b3940310420ca9514579e88e2e47fd68b3ea10047e8460372a'], ['385eed34c1cdff21e6d0818689b81bde71a7f4f18397e6690a841e1599c43862', '283bebc3e8ea23f56701de19e9ebf4576b304eec2086dc8cc0458fe5542e5453'], ['6f9d9b803ecf191637c73a4413dfa180fddf84a5947fbc9c606ed86c3fac3a7', '7c80c68e603059ba69b8e2a30e45c4d47ea4dd2f5c281002d86890603a842160'], ['3322d401243c4e2582a2147c104d6ecbf774d163db0f5e5313b7e0e742d0e6bd', '56e70797e9664ef5bfb019bc4ddaf9b72805f63ea2873af624f3a2e96c28b2a0'], ['85672c7d2de0b7da2bd1770d89665868741b3f9af7643397721d74d28134ab83', '7c481b9b5b43b2eb6374049bfa62c2e5e77f17fcc5298f44c8e3094f790313a6'], ['948bf809b1988a46b06c9f1919413b10f9226c60f668832ffd959af60c82a0a', '53a562856dcb6646dc6b74c5d1c3418c6d4dff08c97cd2bed4cb7f88d8c8e589'], ['6260ce7f461801c34f067ce0f02873a8f1b0e44dfc69752accecd819f38fd8e8', 'bc2da82b6fa5b571a7f09049776a1ef7ecd292238051c198c1a84e95b2b4ae17'], ['e5037de0afc1d8d43d8348414bbf4103043ec8f575bfdc432953cc8d2037fa2d', '4571534baa94d3b5f9f98d09fb990bddbd5f5b03ec481f10e0e5dc841d755bda'], ['e06372b0f4a207adf5ea905e8f1771b4e7e8dbd1c6a6c5b725866a0ae4fce725', '7a908974bce18cfe12a27bb2ad5a488cd7484a7787104870b27034f94eee31dd'], ['213c7a715cd5d45358d0bbf9dc0ce02204b10bdde2a3f58540ad6908d0559754', '4b6dad0b5ae462507013ad06245ba190bb4850f5f36a7eeddff2c27534b458f2'], ['4e7c272a7af4b34e8dbb9352a5419a87e2838c70adc62cddf0cc3a3b08fbd53c', '17749c766c9d0b18e16fd09f6def681b530b9614bff7dd33e0b3941817dcaae6'], ['fea74e3dbe778b1b10f238ad61686aa5c76e3db2be43057632427e2840fb27b6', '6e0568db9b0b13297cf674deccb6af93126b596b973f7b77701d3db7f23cb96f'], ['76e64113f677cf0e10a2570d599968d31544e179b760432952c02a4417bdde39', 'c90ddf8dee4e95cf577066d70681f0d35e2a33d2b56d2032b4b1752d1901ac01'], ['c738c56b03b2abe1e8281baa743f8f9a8f7cc643df26cbee3ab150242bcbb891', '893fb578951ad2537f718f2eacbfbbbb82314eef7880cfe917e735d9699a84c3'], ['d895626548b65b81e264c7637c972877d1d72e5f3a925014372e9f6588f6c14b', 'febfaa38f2bc7eae728ec60818c340eb03428d632bb067e179363ed75d7d991f'], ['b8da94032a957518eb0f6433571e8761ceffc73693e84edd49150a564f676e03', '2804dfa44805a1e4d7c99cc9762808b092cc584d95ff3b511488e4e74efdf6e7'], ['e80fea14441fb33a7d8adab9475d7fab2019effb5156a792f1a11778e3c0df5d', 'eed1de7f638e00771e89768ca3ca94472d155e80af322ea9fcb4291b6ac9ec78'], ['a301697bdfcd704313ba48e51d567543f2a182031efd6915ddc07bbcc4e16070', '7370f91cfb67e4f5081809fa25d40f9b1735dbf7c0a11a130c0d1a041e177ea1'], ['90ad85b389d6b936463f9d0512678de208cc330b11307fffab7ac63e3fb04ed4', 'e507a3620a38261affdcbd9427222b839aefabe1582894d991d4d48cb6ef150'], ['8f68b9d2f63b5f339239c1ad981f162ee88c5678723ea3351b7b444c9ec4c0da', '662a9f2dba063986de1d90c2b6be215dbbea2cfe95510bfdf23cbf79501fff82'], ['e4f3fb0176af85d65ff99ff9198c36091f48e86503681e3e6686fd5053231e11', '1e63633ad0ef4f1c1661a6d0ea02b7286cc7e74ec951d1c9822c38576feb73bc'], ['8c00fa9b18ebf331eb961537a45a4266c7034f2f0d4e1d0716fb6eae20eae29e', 'efa47267fea521a1a9dc343a3736c974c2fadafa81e36c54e7d2a4c66702414b'], ['e7a26ce69dd4829f3e10cec0a9e98ed3143d084f308b92c0997fddfc60cb3e41', '2a758e300fa7984b471b006a1aafbb18d0a6b2c0420e83e20e8a9421cf2cfd51'], ['b6459e0ee3662ec8d23540c223bcbdc571cbcb967d79424f3cf29eb3de6b80ef', '67c876d06f3e06de1dadf16e5661db3c4b3ae6d48e35b2ff30bf0b61a71ba45'], ['d68a80c8280bb840793234aa118f06231d6f1fc67e73c5a5deda0f5b496943e8', 'db8ba9fff4b586d00c4b1f9177b0e28b5b0e7b8f7845295a294c84266b133120'], ['324aed7df65c804252dc0270907a30b09612aeb973449cea4095980fc28d3d5d', '648a365774b61f2ff130c0c35aec1f4f19213b0c7e332843967224af96ab7c84'], ['4df9c14919cde61f6d51dfdbe5fee5dceec4143ba8d1ca888e8bd373fd054c96', '35ec51092d8728050974c23a1d85d4b5d506cdc288490192ebac06cad10d5d'], ['9c3919a84a474870faed8a9c1cc66021523489054d7f0308cbfc99c8ac1f98cd', 'ddb84f0f4a4ddd57584f044bf260e641905326f76c64c8e6be7e5e03d4fc599d'], ['6057170b1dd12fdf8de05f281d8e06bb91e1493a8b91d4cc5a21382120a959e5', '9a1af0b26a6a4807add9a2daf71df262465152bc3ee24c65e899be932385a2a8'], ['a576df8e23a08411421439a4518da31880cef0fba7d4df12b1a6973eecb94266', '40a6bf20e76640b2c92b97afe58cd82c432e10a7f514d9f3ee8be11ae1b28ec8'], ['7778a78c28dec3e30a05fe9629de8c38bb30d1f5cf9a3a208f763889be58ad71', '34626d9ab5a5b22ff7098e12f2ff580087b38411ff24ac563b513fc1fd9f43ac'], ['928955ee637a84463729fd30e7afd2ed5f96274e5ad7e5cb09eda9c06d903ac', 'c25621003d3f42a827b78a13093a95eeac3d26efa8a8d83fc5180e935bcd091f'], ['85d0fef3ec6db109399064f3a0e3b2855645b4a907ad354527aae75163d82751', '1f03648413a38c0be29d496e582cf5663e8751e96877331582c237a24eb1f962'], ['ff2b0dce97eece97c1c9b6041798b85dfdfb6d8882da20308f5404824526087e', '493d13fef524ba188af4c4dc54d07936c7b7ed6fb90e2ceb2c951e01f0c29907'], ['827fbbe4b1e880ea9ed2b2e6301b212b57f1ee148cd6dd28780e5e2cf856e241', 'c60f9c923c727b0b71bef2c67d1d12687ff7a63186903166d605b68baec293ec'], ['eaa649f21f51bdbae7be4ae34ce6e5217a58fdce7f47f9aa7f3b58fa2120e2b3', 'be3279ed5bbbb03ac69a80f89879aa5a01a6b965f13f7e59d47a5305ba5ad93d'], ['e4a42d43c5cf169d9391df6decf42ee541b6d8f0c9a137401e23632dda34d24f', '4d9f92e716d1c73526fc99ccfb8ad34ce886eedfa8d8e4f13a7f7131deba9414'], ['1ec80fef360cbdd954160fadab352b6b92b53576a88fea4947173b9d4300bf19', 'aeefe93756b5340d2f3a4958a7abbf5e0146e77f6295a07b671cdc1cc107cefd'], ['146a778c04670c2f91b00af4680dfa8bce3490717d58ba889ddb5928366642be', 'b318e0ec3354028add669827f9d4b2870aaa971d2f7e5ed1d0b297483d83efd0'], ['fa50c0f61d22e5f07e3acebb1aa07b128d0012209a28b9776d76a8793180eef9', '6b84c6922397eba9b72cd2872281a68a5e683293a57a213b38cd8d7d3f4f2811'], ['da1d61d0ca721a11b1a5bf6b7d88e8421a288ab5d5bba5220e53d32b5f067ec2', '8157f55a7c99306c79c0766161c91e2966a73899d279b48a655fba0f1ad836f1'], ['a8e282ff0c9706907215ff98e8fd416615311de0446f1e062a73b0610d064e13', '7f97355b8db81c09abfb7f3c5b2515888b679a3e50dd6bd6cef7c73111f4cc0c'], ['174a53b9c9a285872d39e56e6913cab15d59b1fa512508c022f382de8319497c', 'ccc9dc37abfc9c1657b4155f2c47f9e6646b3a1d8cb9854383da13ac079afa73'], ['959396981943785c3d3e57edf5018cdbe039e730e4918b3d884fdff09475b7ba', '2e7e552888c331dd8ba0386a4b9cd6849c653f64c8709385e9b8abf87524f2fd'], ['d2a63a50ae401e56d645a1153b109a8fcca0a43d561fba2dbb51340c9d82b151', 'e82d86fb6443fcb7565aee58b2948220a70f750af484ca52d4142174dcf89405'], ['64587e2335471eb890ee7896d7cfdc866bacbdbd3839317b3436f9b45617e073', 'd99fcdd5bf6902e2ae96dd6447c299a185b90a39133aeab358299e5e9faf6589'], ['8481bde0e4e4d885b3a546d3e549de042f0aa6cea250e7fd358d6c86dd45e458', '38ee7b8cba5404dd84a25bf39cecb2ca900a79c42b262e556d64b1b59779057e'], ['13464a57a78102aa62b6979ae817f4637ffcfed3c4b1ce30bcd6303f6caf666b', '69be159004614580ef7e433453ccb0ca48f300a81d0942e13f495a907f6ecc27'], ['bc4a9df5b713fe2e9aef430bcc1dc97a0cd9ccede2f28588cada3a0d2d83f366', 'd3a81ca6e785c06383937adf4b798caa6e8a9fbfa547b16d758d666581f33c1'], ['8c28a97bf8298bc0d23d8c749452a32e694b65e30a9472a3954ab30fe5324caa', '40a30463a3305193378fedf31f7cc0eb7ae784f0451cb9459e71dc73cbef9482'], ['8ea9666139527a8c1dd94ce4f071fd23c8b350c5a4bb33748c4ba111faccae0', '620efabbc8ee2782e24e7c0cfb95c5d735b783be9cf0f8e955af34a30e62b945'], ['dd3625faef5ba06074669716bbd3788d89bdde815959968092f76cc4eb9a9787', '7a188fa3520e30d461da2501045731ca941461982883395937f68d00c644a573'], ['f710d79d9eb962297e4f6232b40e8f7feb2bc63814614d692c12de752408221e', 'ea98e67232d3b3295d3b535532115ccac8612c721851617526ae47a9c77bfc82']]
      },
      'naf': {
        'wnd': 7,
        'points': [['f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9', '388f7b0f632de8140fe337e62a37f3566500a99934c2231b6cb9fd7584b8e672'], ['2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4', 'd8ac222636e5e3d6d4dba9dda6c9c426f788271bab0d6840dca87d3aa6ac62d6'], ['5cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc', '6aebca40ba255960a3178d6d861a54dba813d0b813fde7b5a5082628087264da'], ['acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe', 'cc338921b0a7d9fd64380971763b61e9add888a4375f8e0f05cc262ac64f9c37'], ['774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb', 'd984a032eb6b5e190243dd56d7b7b365372db1e2dff9d6a8301d74c9c953c61b'], ['f28773c2d975288bc7d1d205c3748651b075fbc6610e58cddeeddf8f19405aa8', 'ab0902e8d880a89758212eb65cdaf473a1a06da521fa91f29b5cb52db03ed81'], ['d7924d4f7d43ea965a465ae3095ff41131e5946f3c85f79e44adbcf8e27e080e', '581e2872a86c72a683842ec228cc6defea40af2bd896d3a5c504dc9ff6a26b58'], ['defdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34', '4211ab0694635168e997b0ead2a93daeced1f4a04a95c0f6cfb199f69e56eb77'], ['2b4ea0a797a443d293ef5cff444f4979f06acfebd7e86d277475656138385b6c', '85e89bc037945d93b343083b5a1c86131a01f60c50269763b570c854e5c09b7a'], ['352bbf4a4cdd12564f93fa332ce333301d9ad40271f8107181340aef25be59d5', '321eb4075348f534d59c18259dda3e1f4a1b3b2e71b1039c67bd3d8bcf81998c'], ['2fa2104d6b38d11b0230010559879124e42ab8dfeff5ff29dc9cdadd4ecacc3f', '2de1068295dd865b64569335bd5dd80181d70ecfc882648423ba76b532b7d67'], ['9248279b09b4d68dab21a9b066edda83263c3d84e09572e269ca0cd7f5453714', '73016f7bf234aade5d1aa71bdea2b1ff3fc0de2a887912ffe54a32ce97cb3402'], ['daed4f2be3a8bf278e70132fb0beb7522f570e144bf615c07e996d443dee8729', 'a69dce4a7d6c98e8d4a1aca87ef8d7003f83c230f3afa726ab40e52290be1c55'], ['c44d12c7065d812e8acf28d7cbb19f9011ecd9e9fdf281b0e6a3b5e87d22e7db', '2119a460ce326cdc76c45926c982fdac0e106e861edf61c5a039063f0e0e6482'], ['6a245bf6dc698504c89a20cfded60853152b695336c28063b61c65cbd269e6b4', 'e022cf42c2bd4a708b3f5126f16a24ad8b33ba48d0423b6efd5e6348100d8a82'], ['1697ffa6fd9de627c077e3d2fe541084ce13300b0bec1146f95ae57f0d0bd6a5', 'b9c398f186806f5d27561506e4557433a2cf15009e498ae7adee9d63d01b2396'], ['605bdb019981718b986d0f07e834cb0d9deb8360ffb7f61df982345ef27a7479', '2972d2de4f8d20681a78d93ec96fe23c26bfae84fb14db43b01e1e9056b8c49'], ['62d14dab4150bf497402fdc45a215e10dcb01c354959b10cfe31c7e9d87ff33d', '80fc06bd8cc5b01098088a1950eed0db01aa132967ab472235f5642483b25eaf'], ['80c60ad0040f27dade5b4b06c408e56b2c50e9f56b9b8b425e555c2f86308b6f', '1c38303f1cc5c30f26e66bad7fe72f70a65eed4cbe7024eb1aa01f56430bd57a'], ['7a9375ad6167ad54aa74c6348cc54d344cc5dc9487d847049d5eabb0fa03c8fb', 'd0e3fa9eca8726909559e0d79269046bdc59ea10c70ce2b02d499ec224dc7f7'], ['d528ecd9b696b54c907a9ed045447a79bb408ec39b68df504bb51f459bc3ffc9', 'eecf41253136e5f99966f21881fd656ebc4345405c520dbc063465b521409933'], ['49370a4b5f43412ea25f514e8ecdad05266115e4a7ecb1387231808f8b45963', '758f3f41afd6ed428b3081b0512fd62a54c3f3afbb5b6764b653052a12949c9a'], ['77f230936ee88cbbd73df930d64702ef881d811e0e1498e2f1c13eb1fc345d74', '958ef42a7886b6400a08266e9ba1b37896c95330d97077cbbe8eb3c7671c60d6'], ['f2dac991cc4ce4b9ea44887e5c7c0bce58c80074ab9d4dbaeb28531b7739f530', 'e0dedc9b3b2f8dad4da1f32dec2531df9eb5fbeb0598e4fd1a117dba703a3c37'], ['463b3d9f662621fb1b4be8fbbe2520125a216cdfc9dae3debcba4850c690d45b', '5ed430d78c296c3543114306dd8622d7c622e27c970a1de31cb377b01af7307e'], ['f16f804244e46e2a09232d4aff3b59976b98fac14328a2d1a32496b49998f247', 'cedabd9b82203f7e13d206fcdf4e33d92a6c53c26e5cce26d6579962c4e31df6'], ['caf754272dc84563b0352b7a14311af55d245315ace27c65369e15f7151d41d1', 'cb474660ef35f5f2a41b643fa5e460575f4fa9b7962232a5c32f908318a04476'], ['2600ca4b282cb986f85d0f1709979d8b44a09c07cb86d7c124497bc86f082120', '4119b88753c15bd6a693b03fcddbb45d5ac6be74ab5f0ef44b0be9475a7e4b40'], ['7635ca72d7e8432c338ec53cd12220bc01c48685e24f7dc8c602a7746998e435', '91b649609489d613d1d5e590f78e6d74ecfc061d57048bad9e76f302c5b9c61'], ['754e3239f325570cdbbf4a87deee8a66b7f2b33479d468fbc1a50743bf56cc18', '673fb86e5bda30fb3cd0ed304ea49a023ee33d0197a695d0c5d98093c536683'], ['e3e6bd1071a1e96aff57859c82d570f0330800661d1c952f9fe2694691d9b9e8', '59c9e0bba394e76f40c0aa58379a3cb6a5a2283993e90c4167002af4920e37f5'], ['186b483d056a033826ae73d88f732985c4ccb1f32ba35f4b4cc47fdcf04aa6eb', '3b952d32c67cf77e2e17446e204180ab21fb8090895138b4a4a797f86e80888b'], ['df9d70a6b9876ce544c98561f4be4f725442e6d2b737d9c91a8321724ce0963f', '55eb2dafd84d6ccd5f862b785dc39d4ab157222720ef9da217b8c45cf2ba2417'], ['5edd5cc23c51e87a497ca815d5dce0f8ab52554f849ed8995de64c5f34ce7143', 'efae9c8dbc14130661e8cec030c89ad0c13c66c0d17a2905cdc706ab7399a868'], ['290798c2b6476830da12fe02287e9e777aa3fba1c355b17a722d362f84614fba', 'e38da76dcd440621988d00bcf79af25d5b29c094db2a23146d003afd41943e7a'], ['af3c423a95d9f5b3054754efa150ac39cd29552fe360257362dfdecef4053b45', 'f98a3fd831eb2b749a93b0e6f35cfb40c8cd5aa667a15581bc2feded498fd9c6'], ['766dbb24d134e745cccaa28c99bf274906bb66b26dcf98df8d2fed50d884249a', '744b1152eacbe5e38dcc887980da38b897584a65fa06cedd2c924f97cbac5996'], ['59dbf46f8c94759ba21277c33784f41645f7b44f6c596a58ce92e666191abe3e', 'c534ad44175fbc300f4ea6ce648309a042ce739a7919798cd85e216c4a307f6e'], ['f13ada95103c4537305e691e74e9a4a8dd647e711a95e73cb62dc6018cfd87b8', 'e13817b44ee14de663bf4bc808341f326949e21a6a75c2570778419bdaf5733d'], ['7754b4fa0e8aced06d4167a2c59cca4cda1869c06ebadfb6488550015a88522c', '30e93e864e669d82224b967c3020b8fa8d1e4e350b6cbcc537a48b57841163a2'], ['948dcadf5990e048aa3874d46abef9d701858f95de8041d2a6828c99e2262519', 'e491a42537f6e597d5d28a3224b1bc25df9154efbd2ef1d2cbba2cae5347d57e'], ['7962414450c76c1689c7b48f8202ec37fb224cf5ac0bfa1570328a8a3d7c77ab', '100b610ec4ffb4760d5c1fc133ef6f6b12507a051f04ac5760afa5b29db83437'], ['3514087834964b54b15b160644d915485a16977225b8847bb0dd085137ec47ca', 'ef0afbb2056205448e1652c48e8127fc6039e77c15c2378b7e7d15a0de293311'], ['d3cc30ad6b483e4bc79ce2c9dd8bc54993e947eb8df787b442943d3f7b527eaf', '8b378a22d827278d89c5e9be8f9508ae3c2ad46290358630afb34db04eede0a4'], ['1624d84780732860ce1c78fcbfefe08b2b29823db913f6493975ba0ff4847610', '68651cf9b6da903e0914448c6cd9d4ca896878f5282be4c8cc06e2a404078575'], ['733ce80da955a8a26902c95633e62a985192474b5af207da6df7b4fd5fc61cd4', 'f5435a2bd2badf7d485a4d8b8db9fcce3e1ef8e0201e4578c54673bc1dc5ea1d'], ['15d9441254945064cf1a1c33bbd3b49f8966c5092171e699ef258dfab81c045c', 'd56eb30b69463e7234f5137b73b84177434800bacebfc685fc37bbe9efe4070d'], ['a1d0fcf2ec9de675b612136e5ce70d271c21417c9d2b8aaaac138599d0717940', 'edd77f50bcb5a3cab2e90737309667f2641462a54070f3d519212d39c197a629'], ['e22fbe15c0af8ccc5780c0735f84dbe9a790badee8245c06c7ca37331cb36980', 'a855babad5cd60c88b430a69f53a1a7a38289154964799be43d06d77d31da06'], ['311091dd9860e8e20ee13473c1155f5f69635e394704eaa74009452246cfa9b3', '66db656f87d1f04fffd1f04788c06830871ec5a64feee685bd80f0b1286d8374'], ['34c1fd04d301be89b31c0442d3e6ac24883928b45a9340781867d4232ec2dbdf', '9414685e97b1b5954bd46f730174136d57f1ceeb487443dc5321857ba73abee'], ['f219ea5d6b54701c1c14de5b557eb42a8d13f3abbcd08affcc2a5e6b049b8d63', '4cb95957e83d40b0f73af4544cccf6b1f4b08d3c07b27fb8d8c2962a400766d1'], ['d7b8740f74a8fbaab1f683db8f45de26543a5490bca627087236912469a0b448', 'fa77968128d9c92ee1010f337ad4717eff15db5ed3c049b3411e0315eaa4593b'], ['32d31c222f8f6f0ef86f7c98d3a3335ead5bcd32abdd94289fe4d3091aa824bf', '5f3032f5892156e39ccd3d7915b9e1da2e6dac9e6f26e961118d14b8462e1661'], ['7461f371914ab32671045a155d9831ea8793d77cd59592c4340f86cbc18347b5', '8ec0ba238b96bec0cbdddcae0aa442542eee1ff50c986ea6b39847b3cc092ff6'], ['ee079adb1df1860074356a25aa38206a6d716b2c3e67453d287698bad7b2b2d6', '8dc2412aafe3be5c4c5f37e0ecc5f9f6a446989af04c4e25ebaac479ec1c8c1e'], ['16ec93e447ec83f0467b18302ee620f7e65de331874c9dc72bfd8616ba9da6b5', '5e4631150e62fb40d0e8c2a7ca5804a39d58186a50e497139626778e25b0674d'], ['eaa5f980c245f6f038978290afa70b6bd8855897f98b6aa485b96065d537bd99', 'f65f5d3e292c2e0819a528391c994624d784869d7e6ea67fb18041024edc07dc'], ['78c9407544ac132692ee1910a02439958ae04877151342ea96c4b6b35a49f51', 'f3e0319169eb9b85d5404795539a5e68fa1fbd583c064d2462b675f194a3ddb4'], ['494f4be219a1a77016dcd838431aea0001cdc8ae7a6fc688726578d9702857a5', '42242a969283a5f339ba7f075e36ba2af925ce30d767ed6e55f4b031880d562c'], ['a598a8030da6d86c6bc7f2f5144ea549d28211ea58faa70ebf4c1e665c1fe9b5', '204b5d6f84822c307e4b4a7140737aec23fc63b65b35f86a10026dbd2d864e6b'], ['c41916365abb2b5d09192f5f2dbeafec208f020f12570a184dbadc3e58595997', '4f14351d0087efa49d245b328984989d5caf9450f34bfc0ed16e96b58fa9913'], ['841d6063a586fa475a724604da03bc5b92a2e0d2e0a36acfe4c73a5514742881', '73867f59c0659e81904f9a1c7543698e62562d6744c169ce7a36de01a8d6154'], ['5e95bb399a6971d376026947f89bde2f282b33810928be4ded112ac4d70e20d5', '39f23f366809085beebfc71181313775a99c9aed7d8ba38b161384c746012865'], ['36e4641a53948fd476c39f8a99fd974e5ec07564b5315d8bf99471bca0ef2f66', 'd2424b1b1abe4eb8164227b085c9aa9456ea13493fd563e06fd51cf5694c78fc'], ['336581ea7bfbbb290c191a2f507a41cf5643842170e914faeab27c2c579f726', 'ead12168595fe1be99252129b6e56b3391f7ab1410cd1e0ef3dcdcabd2fda224'], ['8ab89816dadfd6b6a1f2634fcf00ec8403781025ed6890c4849742706bd43ede', '6fdcef09f2f6d0a044e654aef624136f503d459c3e89845858a47a9129cdd24e'], ['1e33f1a746c9c5778133344d9299fcaa20b0938e8acff2544bb40284b8c5fb94', '60660257dd11b3aa9c8ed618d24edff2306d320f1d03010e33a7d2057f3b3b6'], ['85b7c1dcb3cec1b7ee7f30ded79dd20a0ed1f4cc18cbcfcfa410361fd8f08f31', '3d98a9cdd026dd43f39048f25a8847f4fcafad1895d7a633c6fed3c35e999511'], ['29df9fbd8d9e46509275f4b125d6d45d7fbe9a3b878a7af872a2800661ac5f51', 'b4c4fe99c775a606e2d8862179139ffda61dc861c019e55cd2876eb2a27d84b'], ['a0b1cae06b0a847a3fea6e671aaf8adfdfe58ca2f768105c8082b2e449fce252', 'ae434102edde0958ec4b19d917a6a28e6b72da1834aff0e650f049503a296cf2'], ['4e8ceafb9b3e9a136dc7ff67e840295b499dfb3b2133e4ba113f2e4c0e121e5', 'cf2174118c8b6d7a4b48f6d534ce5c79422c086a63460502b827ce62a326683c'], ['d24a44e047e19b6f5afb81c7ca2f69080a5076689a010919f42725c2b789a33b', '6fb8d5591b466f8fc63db50f1c0f1c69013f996887b8244d2cdec417afea8fa3'], ['ea01606a7a6c9cdd249fdfcfacb99584001edd28abbab77b5104e98e8e3b35d4', '322af4908c7312b0cfbfe369f7a7b3cdb7d4494bc2823700cfd652188a3ea98d'], ['af8addbf2b661c8a6c6328655eb96651252007d8c5ea31be4ad196de8ce2131f', '6749e67c029b85f52a034eafd096836b2520818680e26ac8f3dfbcdb71749700'], ['e3ae1974566ca06cc516d47e0fb165a674a3dabcfca15e722f0e3450f45889', '2aeabe7e4531510116217f07bf4d07300de97e4874f81f533420a72eeb0bd6a4'], ['591ee355313d99721cf6993ffed1e3e301993ff3ed258802075ea8ced397e246', 'b0ea558a113c30bea60fc4775460c7901ff0b053d25ca2bdeee98f1a4be5d196'], ['11396d55fda54c49f19aa97318d8da61fa8584e47b084945077cf03255b52984', '998c74a8cd45ac01289d5833a7beb4744ff536b01b257be4c5767bea93ea57a4'], ['3c5d2a1ba39c5a1790000738c9e0c40b8dcdfd5468754b6405540157e017aa7a', 'b2284279995a34e2f9d4de7396fc18b80f9b8b9fdd270f6661f79ca4c81bd257'], ['cc8704b8a60a0defa3a99a7299f2e9c3fbc395afb04ac078425ef8a1793cc030', 'bdd46039feed17881d1e0862db347f8cf395b74fc4bcdc4e940b74e3ac1f1b13'], ['c533e4f7ea8555aacd9777ac5cad29b97dd4defccc53ee7ea204119b2889b197', '6f0a256bc5efdf429a2fb6242f1a43a2d9b925bb4a4b3a26bb8e0f45eb596096'], ['c14f8f2ccb27d6f109f6d08d03cc96a69ba8c34eec07bbcf566d48e33da6593', 'c359d6923bb398f7fd4473e16fe1c28475b740dd098075e6c0e8649113dc3a38'], ['a6cbc3046bc6a450bac24789fa17115a4c9739ed75f8f21ce441f72e0b90e6ef', '21ae7f4680e889bb130619e2c0f95a360ceb573c70603139862afd617fa9b9f'], ['347d6d9a02c48927ebfb86c1359b1caf130a3c0267d11ce6344b39f99d43cc38', '60ea7f61a353524d1c987f6ecec92f086d565ab687870cb12689ff1e31c74448'], ['da6545d2181db8d983f7dcb375ef5866d47c67b1bf31c8cf855ef7437b72656a', '49b96715ab6878a79e78f07ce5680c5d6673051b4935bd897fea824b77dc208a'], ['c40747cc9d012cb1a13b8148309c6de7ec25d6945d657146b9d5994b8feb1111', '5ca560753be2a12fc6de6caf2cb489565db936156b9514e1bb5e83037e0fa2d4'], ['4e42c8ec82c99798ccf3a610be870e78338c7f713348bd34c8203ef4037f3502', '7571d74ee5e0fb92a7a8b33a07783341a5492144cc54bcc40a94473693606437'], ['3775ab7089bc6af823aba2e1af70b236d251cadb0c86743287522a1b3b0dedea', 'be52d107bcfa09d8bcb9736a828cfa7fac8db17bf7a76a2c42ad961409018cf7'], ['cee31cbf7e34ec379d94fb814d3d775ad954595d1314ba8846959e3e82f74e26', '8fd64a14c06b589c26b947ae2bcf6bfa0149ef0be14ed4d80f448a01c43b1c6d'], ['b4f9eaea09b6917619f6ea6a4eb5464efddb58fd45b1ebefcdc1a01d08b47986', '39e5c9925b5a54b07433a4f18c61726f8bb131c012ca542eb24a8ac07200682a'], ['d4263dfc3d2df923a0179a48966d30ce84e2515afc3dccc1b77907792ebcc60e', '62dfaf07a0f78feb30e30d6295853ce189e127760ad6cf7fae164e122a208d54'], ['48457524820fa65a4f8d35eb6930857c0032acc0a4a2de422233eeda897612c4', '25a748ab367979d98733c38a1fa1c2e7dc6cc07db2d60a9ae7a76aaa49bd0f77'], ['dfeeef1881101f2cb11644f3a2afdfc2045e19919152923f367a1767c11cceda', 'ecfb7056cf1de042f9420bab396793c0c390bde74b4bbdff16a83ae09a9a7517'], ['6d7ef6b17543f8373c573f44e1f389835d89bcbc6062ced36c82df83b8fae859', 'cd450ec335438986dfefa10c57fea9bcc521a0959b2d80bbf74b190dca712d10'], ['e75605d59102a5a2684500d3b991f2e3f3c88b93225547035af25af66e04541f', 'f5c54754a8f71ee540b9b48728473e314f729ac5308b06938360990e2bfad125'], ['eb98660f4c4dfaa06a2be453d5020bc99a0c2e60abe388457dd43fefb1ed620c', '6cb9a8876d9cb8520609af3add26cd20a0a7cd8a9411131ce85f44100099223e'], ['13e87b027d8514d35939f2e6892b19922154596941888336dc3563e3b8dba942', 'fef5a3c68059a6dec5d624114bf1e91aac2b9da568d6abeb2570d55646b8adf1'], ['ee163026e9fd6fe017c38f06a5be6fc125424b371ce2708e7bf4491691e5764a', '1acb250f255dd61c43d94ccc670d0f58f49ae3fa15b96623e5430da0ad6c62b2'], ['b268f5ef9ad51e4d78de3a750c2dc89b1e626d43505867999932e5db33af3d80', '5f310d4b3c99b9ebb19f77d41c1dee018cf0d34fd4191614003e945a1216e423'], ['ff07f3118a9df035e9fad85eb6c7bfe42b02f01ca99ceea3bf7ffdba93c4750d', '438136d603e858a3a5c440c38eccbaddc1d2942114e2eddd4740d098ced1f0d8'], ['8d8b9855c7c052a34146fd20ffb658bea4b9f69e0d825ebec16e8c3ce2b526a1', 'cdb559eedc2d79f926baf44fb84ea4d44bcf50fee51d7ceb30e2e7f463036758'], ['52db0b5384dfbf05bfa9d472d7ae26dfe4b851ceca91b1eba54263180da32b63', 'c3b997d050ee5d423ebaf66a6db9f57b3180c902875679de924b69d84a7b375'], ['e62f9490d3d51da6395efd24e80919cc7d0f29c3f3fa48c6fff543becbd43352', '6d89ad7ba4876b0b22c2ca280c682862f342c8591f1daf5170e07bfd9ccafa7d'], ['7f30ea2476b399b4957509c88f77d0191afa2ff5cb7b14fd6d8e7d65aaab1193', 'ca5ef7d4b231c94c3b15389a5f6311e9daff7bb67b103e9880ef4bff637acaec'], ['5098ff1e1d9f14fb46a210fada6c903fef0fb7b4a1dd1d9ac60a0361800b7a00', '9731141d81fc8f8084d37c6e7542006b3ee1b40d60dfe5362a5b132fd17ddc0'], ['32b78c7de9ee512a72895be6b9cbefa6e2f3c4ccce445c96b9f2c81e2778ad58', 'ee1849f513df71e32efc3896ee28260c73bb80547ae2275ba497237794c8753c'], ['e2cb74fddc8e9fbcd076eef2a7c72b0ce37d50f08269dfc074b581550547a4f7', 'd3aa2ed71c9dd2247a62df062736eb0baddea9e36122d2be8641abcb005cc4a4'], ['8438447566d4d7bedadc299496ab357426009a35f235cb141be0d99cd10ae3a8', 'c4e1020916980a4da5d01ac5e6ad330734ef0d7906631c4f2390426b2edd791f'], ['4162d488b89402039b584c6fc6c308870587d9c46f660b878ab65c82c711d67e', '67163e903236289f776f22c25fb8a3afc1732f2b84b4e95dbda47ae5a0852649'], ['3fad3fa84caf0f34f0f89bfd2dcf54fc175d767aec3e50684f3ba4a4bf5f683d', 'cd1bc7cb6cc407bb2f0ca647c718a730cf71872e7d0d2a53fa20efcdfe61826'], ['674f2600a3007a00568c1a7ce05d0816c1fb84bf1370798f1c69532faeb1a86b', '299d21f9413f33b3edf43b257004580b70db57da0b182259e09eecc69e0d38a5'], ['d32f4da54ade74abb81b815ad1fb3b263d82d6c692714bcff87d29bd5ee9f08f', 'f9429e738b8e53b968e99016c059707782e14f4535359d582fc416910b3eea87'], ['30e4e670435385556e593657135845d36fbb6931f72b08cb1ed954f1e3ce3ff6', '462f9bce619898638499350113bbc9b10a878d35da70740dc695a559eb88db7b'], ['be2062003c51cc3004682904330e4dee7f3dcd10b01e580bf1971b04d4cad297', '62188bc49d61e5428573d48a74e1c655b1c61090905682a0d5558ed72dccb9bc'], ['93144423ace3451ed29e0fb9ac2af211cb6e84a601df5993c419859fff5df04a', '7c10dfb164c3425f5c71a3f9d7992038f1065224f72bb9d1d902a6d13037b47c'], ['b015f8044f5fcbdcf21ca26d6c34fb8197829205c7b7d2a7cb66418c157b112c', 'ab8c1e086d04e813744a655b2df8d5f83b3cdc6faa3088c1d3aea1454e3a1d5f'], ['d5e9e1da649d97d89e4868117a465a3a4f8a18de57a140d36b3f2af341a21b52', '4cb04437f391ed73111a13cc1d4dd0db1693465c2240480d8955e8592f27447a'], ['d3ae41047dd7ca065dbf8ed77b992439983005cd72e16d6f996a5316d36966bb', 'bd1aeb21ad22ebb22a10f0303417c6d964f8cdd7df0aca614b10dc14d125ac46'], ['463e2763d885f958fc66cdd22800f0a487197d0a82e377b49f80af87c897b065', 'bfefacdb0e5d0fd7df3a311a94de062b26b80c61fbc97508b79992671ef7ca7f'], ['7985fdfd127c0567c6f53ec1bb63ec3158e597c40bfe747c83cddfc910641917', '603c12daf3d9862ef2b25fe1de289aed24ed291e0ec6708703a5bd567f32ed03'], ['74a1ad6b5f76e39db2dd249410eac7f99e74c59cb83d2d0ed5ff1543da7703e9', 'cc6157ef18c9c63cd6193d83631bbea0093e0968942e8c33d5737fd790e0db08'], ['30682a50703375f602d416664ba19b7fc9bab42c72747463a71d0896b22f6da3', '553e04f6b018b4fa6c8f39e7f311d3176290d0e0f19ca73f17714d9977a22ff8'], ['9e2158f0d7c0d5f26c3791efefa79597654e7a2b2464f52b1ee6c1347769ef57', '712fcdd1b9053f09003a3481fa7762e9ffd7c8ef35a38509e2fbf2629008373'], ['176e26989a43c9cfeba4029c202538c28172e566e3c4fce7322857f3be327d66', 'ed8cc9d04b29eb877d270b4878dc43c19aefd31f4eee09ee7b47834c1fa4b1c3'], ['75d46efea3771e6e68abb89a13ad747ecf1892393dfc4f1b7004788c50374da8', '9852390a99507679fd0b86fd2b39a868d7efc22151346e1a3ca4726586a6bed8'], ['809a20c67d64900ffb698c4c825f6d5f2310fb0451c869345b7319f645605721', '9e994980d9917e22b76b061927fa04143d096ccc54963e6a5ebfa5f3f8e286c1'], ['1b38903a43f7f114ed4500b4eac7083fdefece1cf29c63528d563446f972c180', '4036edc931a60ae889353f77fd53de4a2708b26b6f5da72ad3394119daf408f9']]
      }
    }]
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic/ec/key", ["npm:bn.js@1.3.0", "npm:elliptic@1.0.1/lib/elliptic"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var bn = require("npm:bn.js@1.3.0");
  var elliptic = require("npm:elliptic@1.0.1/lib/elliptic");
  var utils = elliptic.utils;
  var assert = utils.assert;
  function KeyPair(ec, priv, pub) {
    if (priv instanceof KeyPair)
      return priv;
    if (pub instanceof KeyPair)
      return pub;
    if (!priv) {
      priv = pub;
      pub = null;
    }
    if (priv !== null && typeof priv === 'object') {
      if (priv.x) {
        pub = priv;
        priv = null;
      } else if (priv.priv || priv.pub) {
        pub = priv.pub;
        priv = priv.priv;
      }
    }
    this.ec = ec;
    this.priv = null;
    this.pub = null;
    if (this._importPublicHex(priv, pub))
      return ;
    if (pub === 'hex')
      pub = null;
    if (priv)
      this._importPrivate(priv);
    if (pub)
      this._importPublic(pub);
  }
  module.exports = KeyPair;
  KeyPair.prototype.validate = function validate() {
    var pub = this.getPublic();
    if (pub.isInfinity())
      return {
        result: false,
        reason: 'Invalid public key'
      };
    if (!pub.validate())
      return {
        result: false,
        reason: 'Public key is not a point'
      };
    if (!pub.mul(this.ec.curve.n).isInfinity())
      return {
        result: false,
        reason: 'Public key * N != O'
      };
    return {
      result: true,
      reason: null
    };
  };
  KeyPair.prototype.getPublic = function getPublic(compact, enc) {
    if (!this.pub)
      this.pub = this.ec.g.mul(this.priv);
    if (typeof compact === 'string') {
      enc = compact;
      compact = null;
    }
    if (!enc)
      return this.pub;
    var len = this.ec.curve.p.byteLength();
    var x = this.pub.getX().toArray();
    for (var i = x.length; i < len; i++)
      x.unshift(0);
    if (compact) {
      var res = [this.pub.getY().isEven() ? 0x02 : 0x03].concat(x);
    } else {
      var y = this.pub.getY().toArray();
      for (var i = y.length; i < len; i++)
        y.unshift(0);
      var res = [0x04].concat(x, y);
    }
    return utils.encode(res, enc);
  };
  KeyPair.prototype.getPrivate = function getPrivate(enc) {
    if (enc === 'hex')
      return this.priv.toString(16, 2);
    else
      return this.priv;
  };
  KeyPair.prototype._importPrivate = function _importPrivate(key) {
    this.priv = new bn(key, 16);
    this.priv = this.priv.mod(this.ec.curve.n);
  };
  KeyPair.prototype._importPublic = function _importPublic(key) {
    this.pub = this.ec.curve.point(key.x, key.y);
  };
  KeyPair.prototype._importPublicHex = function _importPublic(key, enc) {
    key = utils.toArray(key, enc);
    var len = this.ec.curve.p.byteLength();
    if (key[0] === 0x04 && key.length - 1 === 2 * len) {
      this.pub = this.ec.curve.point(key.slice(1, 1 + len), key.slice(1 + len, 1 + 2 * len));
    } else if ((key[0] === 0x02 || key[0] === 0x03) && key.length - 1 === len) {
      this.pub = this.ec.curve.pointFromX(key[0] === 0x03, key.slice(1, 1 + len));
    } else {
      return false;
    }
    return true;
  };
  KeyPair.prototype.derive = function derive(pub) {
    return pub.mul(this.priv).getX();
  };
  KeyPair.prototype.sign = function sign(msg) {
    return this.ec.sign(msg, this);
  };
  KeyPair.prototype.verify = function verify(msg, signature) {
    return this.ec.verify(msg, signature, this);
  };
  KeyPair.prototype.inspect = function inspect() {
    return '<Key priv: ' + (this.priv && this.priv.toString(16, 2)) + ' pub: ' + (this.pub && this.pub.inspect()) + ' >';
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic/ec/signature", ["npm:bn.js@1.3.0", "npm:elliptic@1.0.1/lib/elliptic"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var bn = require("npm:bn.js@1.3.0");
  var elliptic = require("npm:elliptic@1.0.1/lib/elliptic");
  var utils = elliptic.utils;
  var assert = utils.assert;
  function Signature(r, s) {
    if (r instanceof Signature)
      return r;
    if (this._importDER(r, s))
      return ;
    assert(r && s, 'Signature without r or s');
    this.r = new bn(r, 16);
    this.s = new bn(s, 16);
  }
  module.exports = Signature;
  Signature.prototype._importDER = function _importDER(data, enc) {
    data = utils.toArray(data, enc);
    if (data.length < 6 || data[0] !== 0x30 || data[2] !== 0x02)
      return false;
    var total = data[1];
    if (1 + total > data.length)
      return false;
    var rlen = data[3];
    if (rlen >= 0x80)
      return false;
    if (4 + rlen + 2 >= data.length)
      return false;
    if (data[4 + rlen] !== 0x02)
      return false;
    var slen = data[5 + rlen];
    if (slen >= 0x80)
      return false;
    if (4 + rlen + 2 + slen > data.length)
      return false;
    this.r = new bn(data.slice(4, 4 + rlen));
    this.s = new bn(data.slice(4 + rlen + 2, 4 + rlen + 2 + slen));
    return true;
  };
  Signature.prototype.toDER = function toDER(enc) {
    var r = this.r.toArray();
    var s = this.s.toArray();
    if (r[0] & 0x80)
      r = [0].concat(r);
    if (s[0] & 0x80)
      s = [0].concat(s);
    var total = r.length + s.length + 4;
    var res = [0x30, total, 0x02, r.length];
    res = res.concat(r, [0x02, s.length], s);
    return utils.encode(res, enc);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-rsa@2.0.0/index", ["npm:bn.js@1.3.0", "npm:randombytes@2.0.1", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var bn = require("npm:bn.js@1.3.0");
    var randomBytes = require("npm:randombytes@2.0.1");
    module.exports = crt;
    function blind(priv) {
      var r = getr(priv);
      var blinder = r.toRed(bn.mont(priv.modulus)).redPow(new bn(priv.publicExponent)).fromRed();
      return {
        blinder: blinder,
        unblinder: r.invm(priv.modulus)
      };
    }
    function crt(msg, priv) {
      var blinds = blind(priv);
      var len = priv.modulus.byteLength();
      var mod = bn.mont(priv.modulus);
      var blinded = new bn(msg).mul(blinds.blinder).mod(priv.modulus);
      var c1 = blinded.toRed(bn.mont(priv.prime1));
      var c2 = blinded.toRed(bn.mont(priv.prime2));
      var qinv = priv.coefficient;
      var p = priv.prime1;
      var q = priv.prime2;
      var m1 = c1.redPow(priv.exponent1);
      var m2 = c2.redPow(priv.exponent2);
      m1 = m1.fromRed();
      m2 = m2.fromRed();
      var h = m1.isub(m2).imul(qinv).mod(p);
      h.imul(q);
      m2.iadd(h);
      var out = new Buffer(m2.imul(blinds.unblinder).mod(priv.modulus).toArray());
      if (out.length < len) {
        var prefix = new Buffer(len - out.length);
        prefix.fill(0);
        out = Buffer.concat([prefix, out], len);
      }
      return out;
    }
    crt.getr = getr;
    function getr(priv) {
      var len = priv.modulus.byteLength();
      var r = new bn(randomBytes(len));
      while (r.cmp(priv.modulus) >= 0 || !r.mod(priv.prime1) || !r.mod(priv.prime2)) {
        r = new bn(randomBytes(len));
      }
      return r;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-sign@3.0.1/curves", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  exports['1.3.132.0.10'] = 'secp256k1';
  exports['1.3.132.0.33'] = 'p224';
  exports['1.2.840.10045.3.1.1'] = 'p192';
  exports['1.2.840.10045.3.1.7'] = 'p256';
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-sign@3.0.1/verify", ["npm:parse-asn1@3.0.0", "npm:elliptic@1.0.1", "npm:browserify-sign@3.0.1/curves", "npm:bn.js@1.3.0", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    'use strict';
    var parseKeys = require("npm:parse-asn1@3.0.0");
    var elliptic = require("npm:elliptic@1.0.1");
    var curves = require("npm:browserify-sign@3.0.1/curves");
    var BN = require("npm:bn.js@1.3.0");
    module.exports = verify;
    function verify(sig, hash, key, signType) {
      var pub = parseKeys(key);
      if (pub.type === 'ec') {
        if (signType !== 'ecdsa') {
          throw new Error('wrong public key type');
        }
        return ecVerify(sig, hash, pub);
      } else if (pub.type === 'dsa') {
        if (signType !== 'dsa') {
          throw new Error('wrong public key type');
        }
        return dsaVerify(sig, hash, pub);
      } else {
        if (signType !== 'rsa') {
          throw new Error('wrong public key type');
        }
      }
      var len = pub.modulus.byteLength();
      var pad = [1];
      var padNum = 0;
      while (hash.length + pad.length + 2 < len) {
        pad.push(0xff);
        padNum++;
      }
      pad.push(0x00);
      var i = -1;
      while (++i < hash.length) {
        pad.push(hash[i]);
      }
      pad = new Buffer(pad);
      var red = BN.mont(pub.modulus);
      sig = new BN(sig).toRed(red);
      sig = sig.redPow(new BN(pub.publicExponent));
      sig = new Buffer(sig.fromRed().toArray());
      var out = 0;
      if (padNum < 8) {
        out = 1;
      }
      len = Math.min(sig.length, pad.length);
      if (sig.length !== pad.length) {
        out = 1;
      }
      i = -1;
      while (++i < len) {
        out |= (sig[i] ^ pad[i]);
      }
      return out === 0;
    }
    function ecVerify(sig, hash, pub) {
      var curveId = curves[pub.data.algorithm.curve.join('.')];
      if (!curveId)
        throw new Error('unknown curve ' + pub.data.algorithm.curve.join('.'));
      var curve = new elliptic.ec(curveId);
      var pubkey = pub.data.subjectPrivateKey.data;
      return curve.verify(hash.toString('hex'), sig.toString('hex'), pubkey.toString('hex'));
    }
    function dsaVerify(sig, hash, pub) {
      var p = pub.data.p;
      var q = pub.data.q;
      var g = pub.data.g;
      var y = pub.data.pub_key;
      var unpacked = parseKeys.signature.decode(sig, 'der');
      var s = unpacked.s;
      var r = unpacked.r;
      checkValue(s, q);
      checkValue(r, q);
      var montq = BN.mont(q);
      var montp = BN.mont(p);
      var w = s.invm(q);
      var v = g.toRed(montp).redPow(new BN(hash).mul(w).mod(q)).fromRed().mul(y.toRed(montp).redPow(r.mul(w).mod(q)).fromRed()).mod(p).mod(q);
      return !v.cmp(r);
    }
    function checkValue(b, q) {
      if (b.cmpn(0) <= 0) {
        throw new Error('invalid sig');
      }
      if (b.cmp(q) >= q) {
        throw new Error('invalid sig');
      }
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:create-ecdh@2.0.0/browser", ["npm:elliptic@1.0.1", "npm:bn.js@1.3.0", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var elliptic = require("npm:elliptic@1.0.1");
    var BN = require("npm:bn.js@1.3.0");
    module.exports = function createECDH(curve) {
      return new ECDH(curve);
    };
    var aliases = {
      secp256k1: {
        name: 'secp256k1',
        byteLength: 32
      },
      secp224r1: {
        name: 'p224',
        byteLength: 28
      },
      prime256v1: {
        name: 'p256',
        byteLength: 32
      },
      prime192v1: {
        name: 'p192',
        byteLength: 24
      },
      ed25519: {
        name: 'ed25519',
        byteLength: 32
      }
    };
    aliases.p224 = aliases.secp224r1;
    aliases.p256 = aliases.secp256r1 = aliases.prime256v1;
    aliases.p192 = aliases.secp192r1 = aliases.prime192v1;
    function ECDH(curve) {
      this.curveType = aliases[curve];
      if (!this.curveType) {
        this.curveType = {name: curve};
      }
      this.curve = new elliptic.ec(this.curveType.name);
      this.keys = void 0;
    }
    ECDH.prototype.generateKeys = function(enc, format) {
      this.keys = this.curve.genKeyPair();
      return this.getPublicKey(enc, format);
    };
    ECDH.prototype.computeSecret = function(other, inenc, enc) {
      inenc = inenc || 'utf8';
      if (!Buffer.isBuffer(other)) {
        other = new Buffer(other, inenc);
      }
      other = new BN(other);
      other = other.toString(16);
      var otherPub = this.curve.keyPair(other, 'hex').getPublic();
      var out = otherPub.mul(this.keys.getPrivate()).getX();
      return formatReturnValue(out, enc, this.curveType.byteLength);
    };
    ECDH.prototype.getPublicKey = function(enc, format) {
      var key = this.keys.getPublic(format === 'compressed', true);
      if (format === 'hybrid') {
        if (key[key.length - 1] % 2) {
          key[0] = 7;
        } else {
          key[0] = 6;
        }
      }
      return formatReturnValue(key, enc);
    };
    ECDH.prototype.getPrivateKey = function(enc) {
      return formatReturnValue(this.keys.getPrivate(), enc);
    };
    ECDH.prototype.setPublicKey = function(pub, enc) {
      enc = enc || 'utf8';
      if (!Buffer.isBuffer(pub)) {
        pub = new Buffer(pub, enc);
      }
      var pkey = new BN(pub);
      pkey = pkey.toArray();
      this.keys._importPublicHex(pkey);
      return this;
    };
    ECDH.prototype.setPrivateKey = function(priv, enc) {
      enc = enc || 'utf8';
      if (!Buffer.isBuffer(priv)) {
        priv = new Buffer(priv, enc);
      }
      var _priv = new BN(priv);
      _priv = _priv.toString(16);
      this.keys._importPrivate(_priv);
      return this;
    };
    function formatReturnValue(bn, enc, len) {
      if (!Array.isArray(bn)) {
        bn = bn.toArray();
      }
      var buf = new Buffer(bn);
      if (len && buf.length < len) {
        var zeros = new Buffer(len - buf.length);
        zeros.fill(0);
        buf = Buffer.concat([zeros, buf]);
      }
      if (!enc) {
        return buf;
      } else {
        return buf.toString(enc);
      }
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:public-encrypt@2.0.0/mgf", ["npm:create-hash@1.1.1", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var createHash = require("npm:create-hash@1.1.1");
    module.exports = function(seed, len) {
      var t = new Buffer('');
      var i = 0,
          c;
      while (t.length < len) {
        c = i2ops(i++);
        t = Buffer.concat([t, createHash('sha1').update(seed).update(c).digest()]);
      }
      return t.slice(0, len);
    };
    function i2ops(c) {
      var out = new Buffer(4);
      out.writeUInt32BE(c, 0);
      return out;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:public-encrypt@2.0.0/xor", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = function xor(a, b) {
    var len = a.length;
    var i = -1;
    while (++i < len) {
      a[i] ^= b[i];
    }
    return a;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:public-encrypt@2.0.0/withPublic", ["npm:bn.js@1.3.0", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var bn = require("npm:bn.js@1.3.0");
    function withPublic(paddedMsg, key) {
      return new Buffer(paddedMsg.toRed(bn.mont(key.modulus)).redPow(new bn(key.publicExponent)).fromRed().toArray());
    }
    module.exports = withPublic;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:public-encrypt@2.0.0/privateDecrypt", ["npm:parse-asn1@3.0.0", "npm:public-encrypt@2.0.0/mgf", "npm:public-encrypt@2.0.0/xor", "npm:bn.js@1.3.0", "npm:browserify-rsa@2.0.0", "npm:create-hash@1.1.1", "npm:public-encrypt@2.0.0/withPublic", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var parseKeys = require("npm:parse-asn1@3.0.0");
    var mgf = require("npm:public-encrypt@2.0.0/mgf");
    var xor = require("npm:public-encrypt@2.0.0/xor");
    var bn = require("npm:bn.js@1.3.0");
    var crt = require("npm:browserify-rsa@2.0.0");
    var createHash = require("npm:create-hash@1.1.1");
    var withPublic = require("npm:public-encrypt@2.0.0/withPublic");
    module.exports = function privateDecrypt(private_key, enc, reverse) {
      var padding;
      if (private_key.padding) {
        padding = private_key.padding;
      } else if (reverse) {
        padding = 1;
      } else {
        padding = 4;
      }
      var key = parseKeys(private_key);
      var k = key.modulus.byteLength();
      if (enc.length > k || new bn(enc).cmp(key.modulus) >= 0) {
        throw new Error('decryption error');
      }
      var msg;
      if (reverse) {
        msg = withPublic(new bn(enc), key);
      } else {
        msg = crt(enc, key);
      }
      var zBuffer = new Buffer(k - msg.length);
      zBuffer.fill(0);
      msg = Buffer.concat([zBuffer, msg], k);
      if (padding === 4) {
        return oaep(key, msg);
      } else if (padding === 1) {
        return pkcs1(key, msg, reverse);
      } else if (padding === 3) {
        return msg;
      } else {
        throw new Error('unknown padding');
      }
    };
    function oaep(key, msg) {
      var n = key.modulus;
      var k = key.modulus.byteLength();
      var mLen = msg.length;
      var iHash = createHash('sha1').update(new Buffer('')).digest();
      var hLen = iHash.length;
      var hLen2 = 2 * hLen;
      if (msg[0] !== 0) {
        throw new Error('decryption error');
      }
      var maskedSeed = msg.slice(1, hLen + 1);
      var maskedDb = msg.slice(hLen + 1);
      var seed = xor(maskedSeed, mgf(maskedDb, hLen));
      var db = xor(maskedDb, mgf(seed, k - hLen - 1));
      if (compare(iHash, db.slice(0, hLen))) {
        throw new Error('decryption error');
      }
      var i = hLen;
      while (db[i] === 0) {
        i++;
      }
      if (db[i++] !== 1) {
        throw new Error('decryption error');
      }
      return db.slice(i);
    }
    function pkcs1(key, msg, reverse) {
      var p1 = msg.slice(0, 2);
      var i = 2;
      var status = 0;
      while (msg[i++] !== 0) {
        if (i >= msg.length) {
          status++;
          break;
        }
      }
      var ps = msg.slice(2, i - 1);
      var p2 = msg.slice(i - 1, i);
      if ((p1.toString('hex') !== '0002' && !reverse) || (p1.toString('hex') !== '0001' && reverse)) {
        status++;
      }
      if (ps.length < 8) {
        status++;
      }
      if (status) {
        throw new Error('decryption error');
      }
      return msg.slice(i);
    }
    function compare(a, b) {
      a = new Buffer(a);
      b = new Buffer(b);
      var dif = 0;
      var len = a.length;
      if (a.length !== b.length) {
        dif++;
        len = Math.min(a.length, b.length);
      }
      var i = -1;
      while (++i < len) {
        dif += (a[i] ^ b[i]);
      }
      return dif;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.collection-strong", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.ctx", "npm:core-js@0.9.6/library/modules/$.uid", "npm:core-js@0.9.6/library/modules/$.assert", "npm:core-js@0.9.6/library/modules/$.for-of", "npm:core-js@0.9.6/library/modules/$.iter", "npm:core-js@0.9.6/library/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      ctx = require("npm:core-js@0.9.6/library/modules/$.ctx"),
      safe = require("npm:core-js@0.9.6/library/modules/$.uid").safe,
      assert = require("npm:core-js@0.9.6/library/modules/$.assert"),
      forOf = require("npm:core-js@0.9.6/library/modules/$.for-of"),
      step = require("npm:core-js@0.9.6/library/modules/$.iter").step,
      has = $.has,
      set = $.set,
      isObject = $.isObject,
      hide = $.hide,
      isFrozen = Object.isFrozen || $.core.Object.isFrozen,
      ID = safe('id'),
      O1 = safe('O1'),
      LAST = safe('last'),
      FIRST = safe('first'),
      ITER = safe('iter'),
      SIZE = $.DESC ? safe('size') : 'size',
      id = 0;
  function fastKey(it, create) {
    if (!isObject(it))
      return (typeof it == 'string' ? 'S' : 'P') + it;
    if (isFrozen(it))
      return 'F';
    if (!has(it, ID)) {
      if (!create)
        return 'E';
      hide(it, ID, ++id);
    }
    return 'O' + it[ID];
  }
  function getEntry(that, key) {
    var index = fastKey(key),
        entry;
    if (index != 'F')
      return that[O1][index];
    for (entry = that[FIRST]; entry; entry = entry.n) {
      if (entry.k == key)
        return entry;
    }
  }
  module.exports = {
    getConstructor: function(NAME, IS_MAP, ADDER) {
      function C() {
        var that = assert.inst(this, C, NAME),
            iterable = arguments[0];
        set(that, O1, $.create(null));
        set(that, SIZE, 0);
        set(that, LAST, undefined);
        set(that, FIRST, undefined);
        if (iterable != undefined)
          forOf(iterable, IS_MAP, that[ADDER], that);
      }
      $.mix(C.prototype, {
        clear: function clear() {
          for (var that = this,
              data = that[O1],
              entry = that[FIRST]; entry; entry = entry.n) {
            entry.r = true;
            if (entry.p)
              entry.p = entry.p.n = undefined;
            delete data[entry.i];
          }
          that[FIRST] = that[LAST] = undefined;
          that[SIZE] = 0;
        },
        'delete': function(key) {
          var that = this,
              entry = getEntry(that, key);
          if (entry) {
            var next = entry.n,
                prev = entry.p;
            delete that[O1][entry.i];
            entry.r = true;
            if (prev)
              prev.n = next;
            if (next)
              next.p = prev;
            if (that[FIRST] == entry)
              that[FIRST] = next;
            if (that[LAST] == entry)
              that[LAST] = prev;
            that[SIZE]--;
          }
          return !!entry;
        },
        forEach: function forEach(callbackfn) {
          var f = ctx(callbackfn, arguments[1], 3),
              entry;
          while (entry = entry ? entry.n : this[FIRST]) {
            f(entry.v, entry.k, this);
            while (entry && entry.r)
              entry = entry.p;
          }
        },
        has: function has(key) {
          return !!getEntry(this, key);
        }
      });
      if ($.DESC)
        $.setDesc(C.prototype, 'size', {get: function() {
            return assert.def(this[SIZE]);
          }});
      return C;
    },
    def: function(that, key, value) {
      var entry = getEntry(that, key),
          prev,
          index;
      if (entry) {
        entry.v = value;
      } else {
        that[LAST] = entry = {
          i: index = fastKey(key, true),
          k: key,
          v: value,
          p: prev = that[LAST],
          n: undefined,
          r: false
        };
        if (!that[FIRST])
          that[FIRST] = entry;
        if (prev)
          prev.n = entry;
        that[SIZE]++;
        if (index != 'F')
          that[O1][index] = entry;
      }
      return that;
    },
    getEntry: getEntry,
    setIter: function(C, NAME, IS_MAP) {
      require("npm:core-js@0.9.6/library/modules/$.iter-define")(C, NAME, function(iterated, kind) {
        set(this, ITER, {
          o: iterated,
          k: kind
        });
      }, function() {
        var iter = this[ITER],
            kind = iter.k,
            entry = iter.l;
        while (entry && entry.r)
          entry = entry.p;
        if (!iter.o || !(iter.l = entry = entry ? entry.n : iter.o[FIRST])) {
          iter.o = undefined;
          return step(1);
        }
        if (kind == 'keys')
          return step(0, entry.k);
        if (kind == 'values')
          return step(0, entry.v);
        return step(0, [entry.k, entry.v]);
      }, IS_MAP ? 'entries' : 'values', !IS_MAP, true);
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.collection", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.def", "npm:core-js@0.9.6/library/modules/$.iter", "npm:core-js@0.9.6/library/modules/$.for-of", "npm:core-js@0.9.6/library/modules/$.species", "npm:core-js@0.9.6/library/modules/$.assert", "npm:core-js@0.9.6/library/modules/$.iter-detect", "npm:core-js@0.9.6/library/modules/$.cof"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      $def = require("npm:core-js@0.9.6/library/modules/$.def"),
      BUGGY = require("npm:core-js@0.9.6/library/modules/$.iter").BUGGY,
      forOf = require("npm:core-js@0.9.6/library/modules/$.for-of"),
      species = require("npm:core-js@0.9.6/library/modules/$.species"),
      assertInstance = require("npm:core-js@0.9.6/library/modules/$.assert").inst;
  module.exports = function(NAME, methods, common, IS_MAP, IS_WEAK) {
    var Base = $.g[NAME],
        C = Base,
        ADDER = IS_MAP ? 'set' : 'add',
        proto = C && C.prototype,
        O = {};
    function fixMethod(KEY, CHAIN) {
      var method = proto[KEY];
      if ($.FW)
        proto[KEY] = function(a, b) {
          var result = method.call(this, a === 0 ? 0 : a, b);
          return CHAIN ? this : result;
        };
    }
    if (!$.isFunction(C) || !(IS_WEAK || !BUGGY && proto.forEach && proto.entries)) {
      C = common.getConstructor(NAME, IS_MAP, ADDER);
      $.mix(C.prototype, methods);
    } else {
      var inst = new C,
          chain = inst[ADDER](IS_WEAK ? {} : -0, 1),
          buggyZero;
      if (!require("npm:core-js@0.9.6/library/modules/$.iter-detect")(function(iter) {
        new C(iter);
      })) {
        C = function() {
          assertInstance(this, C, NAME);
          var that = new Base,
              iterable = arguments[0];
          if (iterable != undefined)
            forOf(iterable, IS_MAP, that[ADDER], that);
          return that;
        };
        C.prototype = proto;
        if ($.FW)
          proto.constructor = C;
      }
      IS_WEAK || inst.forEach(function(val, key) {
        buggyZero = 1 / key === -Infinity;
      });
      if (buggyZero) {
        fixMethod('delete');
        fixMethod('has');
        IS_MAP && fixMethod('get');
      }
      if (buggyZero || chain !== inst)
        fixMethod(ADDER, true);
    }
    require("npm:core-js@0.9.6/library/modules/$.cof").set(C, NAME);
    O[NAME] = C;
    $def($def.G + $def.W + $def.F * (C != Base), O);
    species(C);
    species($.core[NAME]);
    if (!IS_WEAK)
      common.setIter(C, NAME, IS_MAP);
    return C;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.collection-to-json", ["npm:core-js@0.9.6/library/modules/$.def", "npm:core-js@0.9.6/library/modules/$.for-of"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/library/modules/$.def"),
      forOf = require("npm:core-js@0.9.6/library/modules/$.for-of");
  module.exports = function(NAME) {
    $def($def.P, NAME, {toJSON: function toJSON() {
        var arr = [];
        forOf(this, false, arr.push, arr);
        return arr;
      }});
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.assign", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.enum-keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      enumKeys = require("npm:core-js@0.9.6/library/modules/$.enum-keys");
  module.exports = Object.assign || function assign(target, source) {
    var T = Object($.assertDefined(target)),
        l = arguments.length,
        i = 1;
    while (l > i) {
      var S = $.ES5Object(arguments[i++]),
          keys = enumKeys(S),
          length = keys.length,
          j = 0,
          key;
      while (length > j)
        T[key = keys[j++]] = S[key];
    }
    return T;
  };
  global.define = __define;
  return module.exports;
});

System.register("bower:fetch@0.8.1/fetch", [], false, function(__require, __exports, __module) {
  System.get("@@global-helpers").prepareGlobal(__module.id, []);
  (function() {
    (function() {
      'use strict';
      if (self.fetch) {
        return ;
      }
      function normalizeName(name) {
        if (typeof name !== 'string') {
          name = name.toString();
        }
        if (/[^a-z0-9\-#$%&'*+.\^_`|~]/i.test(name)) {
          throw new TypeError('Invalid character in header field name');
        }
        return name.toLowerCase();
      }
      function normalizeValue(value) {
        if (typeof value !== 'string') {
          value = value.toString();
        }
        return value;
      }
      function Headers(headers) {
        this.map = {};
        var self = this;
        if (headers instanceof Headers) {
          headers.forEach(function(name, values) {
            values.forEach(function(value) {
              self.append(name, value);
            });
          });
        } else if (headers) {
          Object.getOwnPropertyNames(headers).forEach(function(name) {
            self.append(name, headers[name]);
          });
        }
      }
      Headers.prototype.append = function(name, value) {
        name = normalizeName(name);
        value = normalizeValue(value);
        var list = this.map[name];
        if (!list) {
          list = [];
          this.map[name] = list;
        }
        list.push(value);
      };
      Headers.prototype['delete'] = function(name) {
        delete this.map[normalizeName(name)];
      };
      Headers.prototype.get = function(name) {
        var values = this.map[normalizeName(name)];
        return values ? values[0] : null;
      };
      Headers.prototype.getAll = function(name) {
        return this.map[normalizeName(name)] || [];
      };
      Headers.prototype.has = function(name) {
        return this.map.hasOwnProperty(normalizeName(name));
      };
      Headers.prototype.set = function(name, value) {
        this.map[normalizeName(name)] = [normalizeValue(value)];
      };
      Headers.prototype.forEach = function(callback) {
        var self = this;
        Object.getOwnPropertyNames(this.map).forEach(function(name) {
          callback(name, self.map[name]);
        });
      };
      function consumed(body) {
        if (body.bodyUsed) {
          return Promise.reject(new TypeError('Already read'));
        }
        body.bodyUsed = true;
      }
      function fileReaderReady(reader) {
        return new Promise(function(resolve, reject) {
          reader.onload = function() {
            resolve(reader.result);
          };
          reader.onerror = function() {
            reject(reader.error);
          };
        });
      }
      function readBlobAsArrayBuffer(blob) {
        var reader = new FileReader();
        reader.readAsArrayBuffer(blob);
        return fileReaderReady(reader);
      }
      function readBlobAsText(blob) {
        var reader = new FileReader();
        reader.readAsText(blob);
        return fileReaderReady(reader);
      }
      var support = {
        blob: 'FileReader' in self && 'Blob' in self && (function() {
          try {
            new Blob();
            return true;
          } catch (e) {
            return false;
          }
        })(),
        formData: 'FormData' in self
      };
      function Body() {
        this.bodyUsed = false;
        this._initBody = function(body) {
          this._bodyInit = body;
          if (typeof body === 'string') {
            this._bodyText = body;
          } else if (support.blob && Blob.prototype.isPrototypeOf(body)) {
            this._bodyBlob = body;
          } else if (support.formData && FormData.prototype.isPrototypeOf(body)) {
            this._bodyFormData = body;
          } else if (!body) {
            this._bodyText = '';
          } else {
            throw new Error('unsupported BodyInit type');
          }
        };
        if (support.blob) {
          this.blob = function() {
            var rejected = consumed(this);
            if (rejected) {
              return rejected;
            }
            if (this._bodyBlob) {
              return Promise.resolve(this._bodyBlob);
            } else if (this._bodyFormData) {
              throw new Error('could not read FormData body as blob');
            } else {
              return Promise.resolve(new Blob([this._bodyText]));
            }
          };
          this.arrayBuffer = function() {
            return this.blob().then(readBlobAsArrayBuffer);
          };
          this.text = function() {
            var rejected = consumed(this);
            if (rejected) {
              return rejected;
            }
            if (this._bodyBlob) {
              return readBlobAsText(this._bodyBlob);
            } else if (this._bodyFormData) {
              throw new Error('could not read FormData body as text');
            } else {
              return Promise.resolve(this._bodyText);
            }
          };
        } else {
          this.text = function() {
            var rejected = consumed(this);
            return rejected ? rejected : Promise.resolve(this._bodyText);
          };
        }
        if (support.formData) {
          this.formData = function() {
            return this.text().then(decode);
          };
        }
        this.json = function() {
          return this.text().then(JSON.parse);
        };
        return this;
      }
      var methods = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];
      function normalizeMethod(method) {
        var upcased = method.toUpperCase();
        return (methods.indexOf(upcased) > -1) ? upcased : method;
      }
      function Request(url, options) {
        options = options || {};
        this.url = url;
        this.credentials = options.credentials || 'omit';
        this.headers = new Headers(options.headers);
        this.method = normalizeMethod(options.method || 'GET');
        this.mode = options.mode || null;
        this.referrer = null;
        if ((this.method === 'GET' || this.method === 'HEAD') && options.body) {
          throw new TypeError('Body not allowed for GET or HEAD requests');
        }
        this._initBody(options.body);
      }
      function decode(body) {
        var form = new FormData();
        body.trim().split('&').forEach(function(bytes) {
          if (bytes) {
            var split = bytes.split('=');
            var name = split.shift().replace(/\+/g, ' ');
            var value = split.join('=').replace(/\+/g, ' ');
            form.append(decodeURIComponent(name), decodeURIComponent(value));
          }
        });
        return form;
      }
      function headers(xhr) {
        var head = new Headers();
        var pairs = xhr.getAllResponseHeaders().trim().split('\n');
        pairs.forEach(function(header) {
          var split = header.trim().split(':');
          var key = split.shift().trim();
          var value = split.join(':').trim();
          head.append(key, value);
        });
        return head;
      }
      Body.call(Request.prototype);
      function Response(bodyInit, options) {
        if (!options) {
          options = {};
        }
        this._initBody(bodyInit);
        this.type = 'default';
        this.url = null;
        this.status = options.status;
        this.ok = this.status >= 200 && this.status < 300;
        this.statusText = options.statusText;
        this.headers = options.headers instanceof Headers ? options.headers : new Headers(options.headers);
        this.url = options.url || '';
      }
      Body.call(Response.prototype);
      self.Headers = Headers;
      self.Request = Request;
      self.Response = Response;
      self.fetch = function(input, init) {
        var request;
        if (Request.prototype.isPrototypeOf(input) && !init) {
          request = input;
        } else {
          request = new Request(input, init);
        }
        return new Promise(function(resolve, reject) {
          var xhr = new XMLHttpRequest();
          if (request.credentials === 'cors') {
            xhr.withCredentials = true;
          }
          function responseURL() {
            if ('responseURL' in xhr) {
              return xhr.responseURL;
            }
            if (/^X-Request-URL:/m.test(xhr.getAllResponseHeaders())) {
              return xhr.getResponseHeader('X-Request-URL');
            }
            return ;
          }
          xhr.onload = function() {
            var status = (xhr.status === 1223) ? 204 : xhr.status;
            if (status < 100 || status > 599) {
              reject(new TypeError('Network request failed'));
              return ;
            }
            var options = {
              status: status,
              statusText: xhr.statusText,
              headers: headers(xhr),
              url: responseURL()
            };
            var body = 'response' in xhr ? xhr.response : xhr.responseText;
            resolve(new Response(body, options));
          };
          xhr.onerror = function() {
            reject(new TypeError('Network request failed'));
          };
          xhr.open(request.method, request.url, true);
          if ('responseType' in xhr && support.blob) {
            xhr.responseType = 'blob';
          }
          request.headers.forEach(function(name, values) {
            values.forEach(function(value) {
              xhr.setRequestHeader(name, value);
            });
          });
          xhr.send(typeof request._bodyInit === 'undefined' ? null : request._bodyInit);
        });
      };
      self.fetch.polyfill = true;
    })();
  }).call(System.global);
  return System.get("@@global-helpers").retrieveGlobal(__module.id, false);
});

System.register("src/scripts/lib/x-select", [], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var SELECT_TAG = "select";
  var DIV_TAG = "div";
  var ELEMENT_NODE = 1;
  var Aria = {
    ROLE: "role",
    HAS_POPUP: "aria-haspopup",
    HIDDEN: "aria-hidden",
    LABELLED_BY: "aria-labelledby",
    SET_SIZE: "aria-setsize",
    SELECTED: "aria-selected",
    POSITION_IN_SET: "aria-posinset",
    OWNS: "aria-owns",
    ACTIVE_DESCENDANT: "aria-activedescendant",
    DISABLED: "aria-disabled",
    EXPANDED: "aria-expanded",
    Roles: {
      LISTBOX: "listbox",
      OPTION: "option",
      PRESENTATION: "presentation"
    }
  };
  var Keys = {
    ESCAPE: 27,
    ENTER: 13,
    TAB: 9,
    SPACE: 32,
    LEFT_ARROW: 37,
    UP_ARROW: 38,
    RIGHT_ARROW: 39,
    DOWN_ARROW: 40
  };
  var ClassNames = {
    MAIN_CONTAINER: "x-select",
    SELECT_WRAPPER: "x-select-select-wrapper",
    OPTION_HIGHLIGHTED: "x-select-option-highlighted",
    OPTION_SELECTED: "x-select-option-selected",
    DROPDOWN_INTERACTED: "x-select-dropdown-interacted"
  };
  var matchesImplementationName = (function() {
    var element = document.createElement("div"),
        implementationNames;
    implementationNames = ["matches", "matchesSelector", "webkitMatchesSelector", "mozMatchesSelector", "msMatchesSelector", "oMatchesSelector"];
    return implementationNames.reduce(function(result, name) {
      return !result && (name in element) ? name : result;
    }, null);
  })();
  function XSelectElement(htmlSelectElement) {
    var selectElement = htmlSelectElement ? htmlSelectElement : document.createElement(SELECT_TAG);
    Object.defineProperties(this, {
      _instanceId: {value: this._getId()},
      _selectElement: {value: selectElement},
      _container: {
        value: null,
        writable: true
      },
      _highlightedIndex: {
        value: 0,
        writable: true
      },
      _dropdownVisible: {
        value: false,
        writable: true
      },
      _disabled: {
        value: false,
        writable: true
      }
    });
    this._initialize();
    this._populate();
    this.selectedIndex = this._selectElement.selectedIndex;
  }
  Object.defineProperty(XSelectElement, "_nextId", {
    value: 1,
    writable: true
  });
  Object.defineProperties(XSelectElement.prototype, {
    autofocus: {
      get: function() {
        return this._selectElement.autofocus;
      },
      set: function(value) {
        this._selectElement.autofocus = value;
      },
      enumerable: true
    },
    disabled: {
      get: function() {
        return this._selectElement.disabled;
      },
      set: function(value) {
        this._selectElement.disabled = value;
        this._disabled = value;
        this._selector.setAttribute(Aria.DISABLED, this._disabled ? "true" : "false");
      },
      enumerable: true
    },
    form: {
      get: function() {
        return this._selectElement.form;
      },
      enumerable: true
    },
    name: {
      get: function() {
        return this._selectElement.name;
      },
      set: function(value) {
        this._selectElement.name = value;
      },
      enumerable: true
    },
    required: {
      get: function() {
        return this._selectElement.required;
      },
      set: function(value) {
        this._selectElement.required = value;
      },
      enumerable: true
    },
    size: {
      get: function() {
        return this._selectElement.size;
      },
      set: function(value) {
        this._selectElement.size = value;
      },
      enumerable: true
    },
    type: {
      get: function() {
        return this._selectElement.type;
      },
      enumerable: true
    },
    options: {
      get: function() {
        return this._selectElement.options;
      },
      enumerable: true
    },
    length: {
      get: function() {
        return this._selectElement.size;
      },
      set: function(value) {
        this._selectElement.size = value;
      },
      enumerable: true
    },
    item: {
      value: function(index) {
        return this._selectElement.item(index);
      },
      enumerable: true
    },
    value: {
      get: function() {
        return this._selectElement.value;
      },
      set: function(value) {
        this._selectElement.value = value;
        this.selectedIndex = this._selectElement.selectedIndex;
      },
      enumerable: true
    },
    selectedIndex: {
      get: function() {
        return this._selectElement.selectedIndex;
      },
      set: function(value) {
        var currentlySelected = this._dropdown.querySelector("[" + Aria.SELECTED + "=\"true\"]"),
            newlySelected = this._dropdown.querySelector("[" + Aria.POSITION_IN_SET + "=\"" + (value + 1) + "\"]");
        if (currentlySelected) {
          currentlySelected.setAttribute(Aria.SELECTED, "false");
        }
        newlySelected.setAttribute(Aria.SELECTED, "true");
        this._selectElement.selectedIndex = value;
        var event = new Event('change', {
          'view': window,
          'bubbles': true,
          'cancelable': true
        });
        this._selectElement.dispatchEvent(event);
        this._selectorLabel.innerHTML = "";
        this._selectorLabel.appendChild(document.createTextNode(newlySelected.textContent || newlySelected.innerText));
        this._selector.setAttribute(Aria.ACTIVE_DESCENDANT, newlySelected.id);
        this._highlightIndex(value);
      },
      enumerable: true
    },
    containerElement: {
      get: function() {
        return this._container;
      },
      enumerable: true
    },
    _initialize: {value: function() {
        var container = this._initializeContainer(),
            selector = this._initializeSelector(),
            dropdown = this._initializeDropdown();
        selector.setAttribute(Aria.OWNS, dropdown.id);
        container.appendChild(selector);
        container.appendChild(dropdown);
        selector.addEventListener("click", function(event) {
          if (!this._disabled) {
            if (this._dropdownVisible) {
              this._hideDropDown();
            } else {
              this._showDropDown();
            }
          }
        }.bind(this), false);
        document.body.addEventListener("click", function(event) {
          var target = event.target;
          while (target && target !== document.body) {
            if (target === container) {
              return ;
            }
            target = target.parentNode;
          }
          if (this._dropdownVisible) {
            this._hideDropDown();
            this._highlightIndex(this.selectedIndex);
          }
        }.bind(this), false);
        Object.defineProperty(this, "_container", {value: container});
        Object.defineProperty(this, "_selector", {value: selector});
        Object.defineProperty(this, "_selectorLabel", {value: selector.querySelector("[data-label]")});
        Object.defineProperty(this, "_dropdown", {value: dropdown});
        this.disabled = this._selectElement.disabled;
      }},
    _initializeContainer: {value: function() {
        var container = document.createElement(DIV_TAG),
            selectWrapper = document.createElement(DIV_TAG);
        container.className = ClassNames.MAIN_CONTAINER;
        selectWrapper.className = ClassNames.SELECT_WRAPPER;
        selectWrapper.setAttribute(Aria.HIDDEN, "true");
        this._selectElement.parentNode.insertBefore(container, this._selectElement.nextSibling);
        this._selectElement.parentNode.removeChild(this._selectElement);
        this._selectElement.setAttribute(Aria.HIDDEN, "true");
        this._selectElement.setAttribute(Aria.EXPANDED, "false");
        selectWrapper.appendChild(this._selectElement);
        container.appendChild(selectWrapper);
        return container;
      }},
    _initializeSelector: {value: function() {
        var selector = document.createElement(DIV_TAG),
            label = document.createElement(DIV_TAG),
            arrow = document.createElement(DIV_TAG),
            labelId = "x-select-" + this._instanceId + "-selector-label-" + this._getId();
        selector.tabIndex = this._selectElement.tabIndex;
        selector.className = this._selectElement.className;
        selector.id = this._selectElement.id;
        selector.setAttribute(Aria.ROLE, Aria.Roles.LISTBOX);
        selector.setAttribute(Aria.HAS_POPUP, "true");
        selector.setAttribute(Aria.LABELLED_BY, labelId);
        selector.setAttribute("data-select", "");
        label.id = labelId;
        label.setAttribute("data-label", "");
        arrow.setAttribute(Aria.ROLE, Aria.Roles.PRESENTATION);
        arrow.setAttribute("data-arrow", "");
        arrow.appendChild(document.createTextNode("▼"));
        this._selectElement.tabIndex = -1;
        this._selectElement.removeAttribute("className");
        this._selectElement.removeAttribute("id");
        selector.addEventListener("keypress", function(event) {
          var code = event.keyCode || event.which,
              selectedOption;
          if (code === Keys.SPACE) {
            event.preventDefault();
            if (this._dropdownVisible) {
              this.selectedIndex = this._highlightedIndex;
              this._hideDropDown();
            } else {
              this._showDropDown();
            }
          } else if (code === Keys.ENTER && this._dropdownVisible) {
            this.selectedIndex = this._highlightedIndex;
            this._hideDropDown();
          }
        }.bind(this), false);
        selector.addEventListener("keydown", function(event) {
          var code = event.keyCode || event.which,
              selectedOption;
          if (code === Keys.TAB) {
            this._hideDropDown();
            this._highlightIndex(this.selectedIndex);
          } else if (code === Keys.ESCAPE) {
            this._hideDropDown();
            this._highlightIndex(this.selectedIndex);
          } else if (code === Keys.UP_ARROW && this._dropdownVisible) {
            event.preventDefault();
            this._dropdown.classList.add(ClassNames.DROPDOWN_INTERACTED);
            this._highlightIndex(this._highlightedIndex - 1);
          } else if (code === Keys.DOWN_ARROW && this._dropdownVisible) {
            event.preventDefault();
            this._dropdown.classList.add(ClassNames.DROPDOWN_INTERACTED);
            this._highlightIndex(this._highlightedIndex + 1);
          }
        }.bind(this), false);
        selector.appendChild(label);
        selector.appendChild(arrow);
        return selector;
      }},
    _initializeDropdown: {value: function() {
        var dropdown = document.createElement(DIV_TAG),
            id = "x-select-" + this._instanceId + "-dropdown-" + this._getId();
        dropdown.id = id;
        dropdown.setAttribute(Aria.HIDDEN, "true");
        dropdown.setAttribute("data-dropdown", "");
        dropdown.addEventListener("mouseover", function(event) {
          var target = event.target,
              related = event.relatedTarget,
              match;
          dropdown.classList.add(ClassNames.DROPDOWN_INTERACTED);
          while (target && target !== document && !(match = target[matchesImplementationName]("[data-option]"))) {
            target = target.parentNode;
          }
          if (!match) {
            return ;
          }
          while (related && related !== target && related !== document) {
            related = related.parentNode;
          }
          if (related == target) {
            return ;
          }
          this._highlightIndex(parseInt(target.getAttribute(Aria.POSITION_IN_SET)) - 1);
        }.bind(this), false);
        dropdown.addEventListener("mouseout", function(event) {
          var target = event.target,
              related = event.relatedTarget,
              match;
          while (target && target !== document && !(match = target[matchesImplementationName]("[data-option]"))) {
            target = target.parentNode;
          }
          if (!match) {
            return ;
          }
          while (related && related !== target && related !== document) {
            related = related.parentNode;
          }
          if (related == target) {
            return ;
          }
          target.classList.remove(ClassNames.OPTION_HIGHLIGHTED);
        }, false);
        dropdown.addEventListener("click", function(event) {
          var target = event.target,
              match;
          while (target && target !== document && !(match = target[matchesImplementationName]("[data-option]"))) {
            target = target.parentNode;
          }
          if (!match) {
            return ;
          }
          this._hideDropDown();
          this.selectedIndex = this._highlightedIndex;
          this._selector.focus();
        }.bind(this), false);
        return dropdown;
      }},
    _populate: {value: function() {
        var selectOptions = this._selectElement.options,
            fragment = document.createDocumentFragment(),
            selectedOption,
            selectedOptionLabel,
            selectedIndex = 0,
            option,
            i,
            length;
        for (i = 0, length = selectOptions.length; i < length; i++) {
          option = this._createOption(selectOptions[i]);
          option.setAttribute(Aria.SET_SIZE, length);
          option.setAttribute(Aria.POSITION_IN_SET, i + 1);
          option.setAttribute(Aria.SELECTED, selectOptions[i].selected ? "true" : "false");
          if (selectOptions[i].selected) {
            selectedIndex = i;
          }
          fragment.appendChild(option);
        }
        this._dropdown.appendChild(fragment);
      }},
    _createOption: {value: function(htmlOptionElement) {
        var option = document.createElement(DIV_TAG),
            label = document.createTextNode(htmlOptionElement.textContent || htmlOptionElement.innerText);
        option.appendChild(label);
        option.setAttribute(Aria.ROLE, Aria.Roles.OPTION);
        option.setAttribute("data-option", "");
        option.id = "x-select-" + this._instanceId + "-dropdown-option-" + this._getId();
        return option;
      }},
    _showDropDown: {value: function() {
        this._selector.setAttribute(Aria.EXPANDED, "true");
        this._dropdown.setAttribute(Aria.HIDDEN, "false");
        this._dropdownVisible = true;
      }},
    _hideDropDown: {value: function() {
        this._selector.setAttribute(Aria.EXPANDED, "false");
        this._dropdown.setAttribute(Aria.HIDDEN, "true");
        this._dropdownVisible = false;
        this._dropdown.classList.remove(ClassNames.DROPDOWN_INTERACTED);
      }},
    _highlightIndex: {value: function(value) {
        var currentOption = this._dropdown.querySelector("[" + Aria.POSITION_IN_SET + "=\"" + (this._highlightedIndex + 1) + "\"]"),
            newOption;
        if (value < 0) {
          value = 0;
        }
        if (value >= this._selectElement.options.length) {
          value = this._selectElement.options.length - 1;
        }
        newOption = this._dropdown.querySelector("[" + Aria.POSITION_IN_SET + "=\"" + (value + 1) + "\"]");
        if (currentOption) {
          currentOption.classList.remove(ClassNames.OPTION_HIGHLIGHTED);
        }
        if (newOption) {
          newOption.classList.add(ClassNames.OPTION_HIGHLIGHTED);
          this._highlightedIndex = value;
        }
      }},
    _getId: {value: function() {
        var id = (this.constructor._nextId++).toString(),
            ID_LENGTH = 5;
        return Array.apply(Array, Array(ID_LENGTH - id.length)).map(function() {
          return "0";
        }).join("") + id;
      }}
  });
  module.exports = XSelectElement;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$", ["npm:core-js@0.9.6/library/modules/$.fw"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var global = typeof self != 'undefined' ? self : Function('return this')(),
      core = {},
      defineProperty = Object.defineProperty,
      hasOwnProperty = {}.hasOwnProperty,
      ceil = Math.ceil,
      floor = Math.floor,
      max = Math.max,
      min = Math.min;
  var DESC = !!function() {
    try {
      return defineProperty({}, 'a', {get: function() {
          return 2;
        }}).a == 2;
    } catch (e) {}
  }();
  var hide = createDefiner(1);
  function toInteger(it) {
    return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
  }
  function desc(bitmap, value) {
    return {
      enumerable: !(bitmap & 1),
      configurable: !(bitmap & 2),
      writable: !(bitmap & 4),
      value: value
    };
  }
  function simpleSet(object, key, value) {
    object[key] = value;
    return object;
  }
  function createDefiner(bitmap) {
    return DESC ? function(object, key, value) {
      return $.setDesc(object, key, desc(bitmap, value));
    } : simpleSet;
  }
  function isObject(it) {
    return it !== null && (typeof it == 'object' || typeof it == 'function');
  }
  function isFunction(it) {
    return typeof it == 'function';
  }
  function assertDefined(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  }
  var $ = module.exports = require("npm:core-js@0.9.6/library/modules/$.fw")({
    g: global,
    core: core,
    html: global.document && document.documentElement,
    isObject: isObject,
    isFunction: isFunction,
    it: function(it) {
      return it;
    },
    that: function() {
      return this;
    },
    toInteger: toInteger,
    toLength: function(it) {
      return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0;
    },
    toIndex: function(index, length) {
      index = toInteger(index);
      return index < 0 ? max(index + length, 0) : min(index, length);
    },
    has: function(it, key) {
      return hasOwnProperty.call(it, key);
    },
    create: Object.create,
    getProto: Object.getPrototypeOf,
    DESC: DESC,
    desc: desc,
    getDesc: Object.getOwnPropertyDescriptor,
    setDesc: defineProperty,
    setDescs: Object.defineProperties,
    getKeys: Object.keys,
    getNames: Object.getOwnPropertyNames,
    getSymbols: Object.getOwnPropertySymbols,
    assertDefined: assertDefined,
    ES5Object: Object,
    toObject: function(it) {
      return $.ES5Object(assertDefined(it));
    },
    hide: hide,
    def: createDefiner(0),
    set: global.Symbol ? simpleSet : hide,
    mix: function(target, src) {
      for (var key in src)
        hide(target, key, src[key]);
      return target;
    },
    each: [].forEach
  });
  if (typeof __e != 'undefined')
    __e = core;
  if (typeof __g != 'undefined')
    __g = global;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.cof", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      TAG = require("npm:core-js@0.9.6/library/modules/$.wks")('toStringTag'),
      toString = {}.toString;
  function cof(it) {
    return toString.call(it).slice(8, -1);
  }
  cof.classof = function(it) {
    var O,
        T;
    return it == undefined ? it === undefined ? 'Undefined' : 'Null' : typeof(T = (O = Object(it))[TAG]) == 'string' ? T : cof(O);
  };
  cof.set = function(it, tag, stat) {
    if (it && !$.has(it = stat ? it : it.prototype, TAG))
      $.hide(it, TAG, tag);
  };
  module.exports = cof;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.iter-define", ["npm:core-js@0.9.6/library/modules/$.def", "npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.cof", "npm:core-js@0.9.6/library/modules/$.iter", "npm:core-js@0.9.6/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/library/modules/$.def"),
      $ = require("npm:core-js@0.9.6/library/modules/$"),
      cof = require("npm:core-js@0.9.6/library/modules/$.cof"),
      $iter = require("npm:core-js@0.9.6/library/modules/$.iter"),
      SYMBOL_ITERATOR = require("npm:core-js@0.9.6/library/modules/$.wks")('iterator'),
      FF_ITERATOR = '@@iterator',
      KEYS = 'keys',
      VALUES = 'values',
      Iterators = $iter.Iterators;
  module.exports = function(Base, NAME, Constructor, next, DEFAULT, IS_SET, FORCE) {
    $iter.create(Constructor, NAME, next);
    function createMethod(kind) {
      function $$(that) {
        return new Constructor(that, kind);
      }
      switch (kind) {
        case KEYS:
          return function keys() {
            return $$(this);
          };
        case VALUES:
          return function values() {
            return $$(this);
          };
      }
      return function entries() {
        return $$(this);
      };
    }
    var TAG = NAME + ' Iterator',
        proto = Base.prototype,
        _native = proto[SYMBOL_ITERATOR] || proto[FF_ITERATOR] || DEFAULT && proto[DEFAULT],
        _default = _native || createMethod(DEFAULT),
        methods,
        key;
    if (_native) {
      var IteratorPrototype = $.getProto(_default.call(new Base));
      cof.set(IteratorPrototype, TAG, true);
      if ($.FW && $.has(proto, FF_ITERATOR))
        $iter.set(IteratorPrototype, $.that);
    }
    if ($.FW)
      $iter.set(proto, _default);
    Iterators[NAME] = _default;
    Iterators[TAG] = $.that;
    if (DEFAULT) {
      methods = {
        keys: IS_SET ? _default : createMethod(KEYS),
        values: DEFAULT == VALUES ? _default : createMethod(VALUES),
        entries: DEFAULT != VALUES ? _default : createMethod('entries')
      };
      if (FORCE)
        for (key in methods) {
          if (!(key in proto))
            $.hide(proto, key, methods[key]);
        }
      else
        $def($def.P + $def.F * $iter.BUGGY, NAME, methods);
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/es6.array.from", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.ctx", "npm:core-js@0.9.6/library/modules/$.def", "npm:core-js@0.9.6/library/modules/$.iter", "npm:core-js@0.9.6/library/modules/$.iter-call", "npm:core-js@0.9.6/library/modules/$.iter-detect"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      ctx = require("npm:core-js@0.9.6/library/modules/$.ctx"),
      $def = require("npm:core-js@0.9.6/library/modules/$.def"),
      $iter = require("npm:core-js@0.9.6/library/modules/$.iter"),
      call = require("npm:core-js@0.9.6/library/modules/$.iter-call");
  $def($def.S + $def.F * !require("npm:core-js@0.9.6/library/modules/$.iter-detect")(function(iter) {
    Array.from(iter);
  }), 'Array', {from: function from(arrayLike) {
      var O = Object($.assertDefined(arrayLike)),
          mapfn = arguments[1],
          mapping = mapfn !== undefined,
          f = mapping ? ctx(mapfn, arguments[2], 2) : undefined,
          index = 0,
          length,
          result,
          step,
          iterator;
      if ($iter.is(O)) {
        iterator = $iter.get(O);
        result = new (typeof this == 'function' ? this : Array);
        for (; !(step = iterator.next()).done; index++) {
          result[index] = mapping ? call(iterator, f, [step.value, index], true) : step.value;
        }
      } else {
        result = new (typeof this == 'function' ? this : Array)(length = $.toLength(O.length));
        for (; length > index; index++) {
          result[index] = mapping ? f(O[index], index) : O[index];
        }
      }
      result.length = index;
      return result;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/es6.array.iterator", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.unscope", "npm:core-js@0.9.6/library/modules/$.uid", "npm:core-js@0.9.6/library/modules/$.iter", "npm:core-js@0.9.6/library/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      setUnscope = require("npm:core-js@0.9.6/library/modules/$.unscope"),
      ITER = require("npm:core-js@0.9.6/library/modules/$.uid").safe('iter'),
      $iter = require("npm:core-js@0.9.6/library/modules/$.iter"),
      step = $iter.step,
      Iterators = $iter.Iterators;
  require("npm:core-js@0.9.6/library/modules/$.iter-define")(Array, 'Array', function(iterated, kind) {
    $.set(this, ITER, {
      o: $.toObject(iterated),
      i: 0,
      k: kind
    });
  }, function() {
    var iter = this[ITER],
        O = iter.o,
        kind = iter.k,
        index = iter.i++;
    if (!O || index >= O.length) {
      iter.o = undefined;
      return step(1);
    }
    if (kind == 'keys')
      return step(0, index);
    if (kind == 'values')
      return step(0, O[index]);
    return step(0, [index, O[index]]);
  }, 'values');
  Iterators.Arguments = Iterators.Array;
  setUnscope('keys');
  setUnscope('values');
  setUnscope('entries');
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/core-js/get-iterator", ["npm:core-js@0.9.6/library/fn/get-iterator"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.6/library/fn/get-iterator"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:process@0.10.1", ["npm:process@0.10.1/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:process@0.10.1/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$", ["npm:core-js@0.9.6/modules/$.fw"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var global = typeof self != 'undefined' ? self : Function('return this')(),
      core = {},
      defineProperty = Object.defineProperty,
      hasOwnProperty = {}.hasOwnProperty,
      ceil = Math.ceil,
      floor = Math.floor,
      max = Math.max,
      min = Math.min;
  var DESC = !!function() {
    try {
      return defineProperty({}, 'a', {get: function() {
          return 2;
        }}).a == 2;
    } catch (e) {}
  }();
  var hide = createDefiner(1);
  function toInteger(it) {
    return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
  }
  function desc(bitmap, value) {
    return {
      enumerable: !(bitmap & 1),
      configurable: !(bitmap & 2),
      writable: !(bitmap & 4),
      value: value
    };
  }
  function simpleSet(object, key, value) {
    object[key] = value;
    return object;
  }
  function createDefiner(bitmap) {
    return DESC ? function(object, key, value) {
      return $.setDesc(object, key, desc(bitmap, value));
    } : simpleSet;
  }
  function isObject(it) {
    return it !== null && (typeof it == 'object' || typeof it == 'function');
  }
  function isFunction(it) {
    return typeof it == 'function';
  }
  function assertDefined(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  }
  var $ = module.exports = require("npm:core-js@0.9.6/modules/$.fw")({
    g: global,
    core: core,
    html: global.document && document.documentElement,
    isObject: isObject,
    isFunction: isFunction,
    it: function(it) {
      return it;
    },
    that: function() {
      return this;
    },
    toInteger: toInteger,
    toLength: function(it) {
      return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0;
    },
    toIndex: function(index, length) {
      index = toInteger(index);
      return index < 0 ? max(index + length, 0) : min(index, length);
    },
    has: function(it, key) {
      return hasOwnProperty.call(it, key);
    },
    create: Object.create,
    getProto: Object.getPrototypeOf,
    DESC: DESC,
    desc: desc,
    getDesc: Object.getOwnPropertyDescriptor,
    setDesc: defineProperty,
    setDescs: Object.defineProperties,
    getKeys: Object.keys,
    getNames: Object.getOwnPropertyNames,
    getSymbols: Object.getOwnPropertySymbols,
    assertDefined: assertDefined,
    ES5Object: Object,
    toObject: function(it) {
      return $.ES5Object(assertDefined(it));
    },
    hide: hide,
    def: createDefiner(0),
    set: global.Symbol ? simpleSet : hide,
    mix: function(target, src) {
      for (var key in src)
        hide(target, key, src[key]);
      return target;
    },
    each: [].forEach
  });
  if (typeof __e != 'undefined')
    __e = core;
  if (typeof __g != 'undefined')
    __g = global;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.wks", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.uid"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var global = require("npm:core-js@0.9.6/modules/$").g,
      store = {};
  module.exports = function(name) {
    return store[name] || (store[name] = global.Symbol && global.Symbol[name] || require("npm:core-js@0.9.6/modules/$.uid").safe('Symbol.' + name));
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.ctx", ["npm:core-js@0.9.6/modules/$.assert"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var assertFunction = require("npm:core-js@0.9.6/modules/$.assert").fn;
  module.exports = function(fn, that, length) {
    assertFunction(fn);
    if (~length && that === undefined)
      return fn;
    switch (length) {
      case 1:
        return function(a) {
          return fn.call(that, a);
        };
      case 2:
        return function(a, b) {
          return fn.call(that, a, b);
        };
      case 3:
        return function(a, b, c) {
          return fn.call(that, a, b, c);
        };
    }
    return function() {
      return fn.apply(that, arguments);
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.symbol", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.cof", "npm:core-js@0.9.6/modules/$.uid", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.keyof", "npm:core-js@0.9.6/modules/$.enum-keys", "npm:core-js@0.9.6/modules/$.assert", "npm:core-js@0.9.6/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      setTag = require("npm:core-js@0.9.6/modules/$.cof").set,
      uid = require("npm:core-js@0.9.6/modules/$.uid"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      keyOf = require("npm:core-js@0.9.6/modules/$.keyof"),
      enumKeys = require("npm:core-js@0.9.6/modules/$.enum-keys"),
      assertObject = require("npm:core-js@0.9.6/modules/$.assert").obj,
      has = $.has,
      $create = $.create,
      getDesc = $.getDesc,
      setDesc = $.setDesc,
      desc = $.desc,
      getNames = $.getNames,
      toObject = $.toObject,
      $Symbol = $.g.Symbol,
      setter = false,
      TAG = uid('tag'),
      HIDDEN = uid('hidden'),
      SymbolRegistry = {},
      AllSymbols = {},
      useNative = $.isFunction($Symbol);
  function wrap(tag) {
    var sym = AllSymbols[tag] = $.set($create($Symbol.prototype), TAG, tag);
    $.DESC && setter && setDesc(Object.prototype, tag, {
      configurable: true,
      set: function(value) {
        if (has(this, HIDDEN) && has(this[HIDDEN], tag))
          this[HIDDEN][tag] = false;
        setDesc(this, tag, desc(1, value));
      }
    });
    return sym;
  }
  function defineProperty(it, key, D) {
    if (D && has(AllSymbols, key)) {
      if (!D.enumerable) {
        if (!has(it, HIDDEN))
          setDesc(it, HIDDEN, desc(1, {}));
        it[HIDDEN][key] = true;
      } else {
        if (has(it, HIDDEN) && it[HIDDEN][key])
          it[HIDDEN][key] = false;
        D.enumerable = false;
      }
    }
    return setDesc(it, key, D);
  }
  function defineProperties(it, P) {
    assertObject(it);
    var keys = enumKeys(P = toObject(P)),
        i = 0,
        l = keys.length,
        key;
    while (l > i)
      defineProperty(it, key = keys[i++], P[key]);
    return it;
  }
  function create(it, P) {
    return P === undefined ? $create(it) : defineProperties($create(it), P);
  }
  function getOwnPropertyDescriptor(it, key) {
    var D = getDesc(it = toObject(it), key);
    if (D && has(AllSymbols, key) && !(has(it, HIDDEN) && it[HIDDEN][key]))
      D.enumerable = true;
    return D;
  }
  function getOwnPropertyNames(it) {
    var names = getNames(toObject(it)),
        result = [],
        i = 0,
        key;
    while (names.length > i)
      if (!has(AllSymbols, key = names[i++]) && key != HIDDEN)
        result.push(key);
    return result;
  }
  function getOwnPropertySymbols(it) {
    var names = getNames(toObject(it)),
        result = [],
        i = 0,
        key;
    while (names.length > i)
      if (has(AllSymbols, key = names[i++]))
        result.push(AllSymbols[key]);
    return result;
  }
  if (!useNative) {
    $Symbol = function Symbol(description) {
      if (this instanceof $Symbol)
        throw TypeError('Symbol is not a constructor');
      return wrap(uid(description));
    };
    $.hide($Symbol.prototype, 'toString', function() {
      return this[TAG];
    });
    $.create = create;
    $.setDesc = defineProperty;
    $.getDesc = getOwnPropertyDescriptor;
    $.setDescs = defineProperties;
    $.getNames = getOwnPropertyNames;
    $.getSymbols = getOwnPropertySymbols;
  }
  var symbolStatics = {
    'for': function(key) {
      return has(SymbolRegistry, key += '') ? SymbolRegistry[key] : SymbolRegistry[key] = $Symbol(key);
    },
    keyFor: function keyFor(key) {
      return keyOf(SymbolRegistry, key);
    },
    useSetter: function() {
      setter = true;
    },
    useSimple: function() {
      setter = false;
    }
  };
  $.each.call(('hasInstance,isConcatSpreadable,iterator,match,replace,search,' + 'species,split,toPrimitive,toStringTag,unscopables').split(','), function(it) {
    var sym = require("npm:core-js@0.9.6/modules/$.wks")(it);
    symbolStatics[it] = useNative ? sym : wrap(sym);
  });
  setter = true;
  $def($def.G + $def.W, {Symbol: $Symbol});
  $def($def.S, 'Symbol', symbolStatics);
  $def($def.S + $def.F * !useNative, 'Object', {
    create: create,
    defineProperty: defineProperty,
    defineProperties: defineProperties,
    getOwnPropertyDescriptor: getOwnPropertyDescriptor,
    getOwnPropertyNames: getOwnPropertyNames,
    getOwnPropertySymbols: getOwnPropertySymbols
  });
  setTag($Symbol, 'Symbol');
  setTag(Math, 'Math', true);
  setTag($.g.JSON, 'JSON', true);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.object.assign", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/modules/$.def");
  $def($def.S, 'Object', {assign: require("npm:core-js@0.9.6/modules/$.assign")});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.object.set-prototype-of", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.set-proto"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/modules/$.def");
  $def($def.S, 'Object', {setPrototypeOf: require("npm:core-js@0.9.6/modules/$.set-proto").set});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.string.iterator", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.string-at", "npm:core-js@0.9.6/modules/$.uid", "npm:core-js@0.9.6/modules/$.iter", "npm:core-js@0.9.6/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var set = require("npm:core-js@0.9.6/modules/$").set,
      $at = require("npm:core-js@0.9.6/modules/$.string-at")(true),
      ITER = require("npm:core-js@0.9.6/modules/$.uid").safe('iter'),
      $iter = require("npm:core-js@0.9.6/modules/$.iter"),
      step = $iter.step;
  require("npm:core-js@0.9.6/modules/$.iter-define")(String, 'String', function(iterated) {
    set(this, ITER, {
      o: String(iterated),
      i: 0
    });
  }, function() {
    var iter = this[ITER],
        O = iter.o,
        index = iter.i,
        point;
    if (index >= O.length)
      return step(1);
    point = $at(O, index);
    iter.i += point.length;
    return step(0, point);
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.string.repeat", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.string-repeat"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/modules/$.def");
  $def($def.P, 'String', {repeat: require("npm:core-js@0.9.6/modules/$.string-repeat")});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.array.from", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.ctx", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.iter", "npm:core-js@0.9.6/modules/$.iter-call", "npm:core-js@0.9.6/modules/$.iter-detect"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      ctx = require("npm:core-js@0.9.6/modules/$.ctx"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      $iter = require("npm:core-js@0.9.6/modules/$.iter"),
      call = require("npm:core-js@0.9.6/modules/$.iter-call");
  $def($def.S + $def.F * !require("npm:core-js@0.9.6/modules/$.iter-detect")(function(iter) {
    Array.from(iter);
  }), 'Array', {from: function from(arrayLike) {
      var O = Object($.assertDefined(arrayLike)),
          mapfn = arguments[1],
          mapping = mapfn !== undefined,
          f = mapping ? ctx(mapfn, arguments[2], 2) : undefined,
          index = 0,
          length,
          result,
          step,
          iterator;
      if ($iter.is(O)) {
        iterator = $iter.get(O);
        result = new (typeof this == 'function' ? this : Array);
        for (; !(step = iterator.next()).done; index++) {
          result[index] = mapping ? call(iterator, f, [step.value, index], true) : step.value;
        }
      } else {
        result = new (typeof this == 'function' ? this : Array)(length = $.toLength(O.length));
        for (; length > index; index++) {
          result[index] = mapping ? f(O[index], index) : O[index];
        }
      }
      result.length = index;
      return result;
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.array.iterator", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.unscope", "npm:core-js@0.9.6/modules/$.uid", "npm:core-js@0.9.6/modules/$.iter", "npm:core-js@0.9.6/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      setUnscope = require("npm:core-js@0.9.6/modules/$.unscope"),
      ITER = require("npm:core-js@0.9.6/modules/$.uid").safe('iter'),
      $iter = require("npm:core-js@0.9.6/modules/$.iter"),
      step = $iter.step,
      Iterators = $iter.Iterators;
  require("npm:core-js@0.9.6/modules/$.iter-define")(Array, 'Array', function(iterated, kind) {
    $.set(this, ITER, {
      o: $.toObject(iterated),
      i: 0,
      k: kind
    });
  }, function() {
    var iter = this[ITER],
        O = iter.o,
        kind = iter.k,
        index = iter.i++;
    if (!O || index >= O.length) {
      iter.o = undefined;
      return step(1);
    }
    if (kind == 'keys')
      return step(0, index);
    if (kind == 'values')
      return step(0, O[index]);
    return step(0, [index, O[index]]);
  }, 'values');
  Iterators.Arguments = Iterators.Array;
  setUnscope('keys');
  setUnscope('values');
  setUnscope('entries');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.array.species", ["npm:core-js@0.9.6/modules/$.species"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/modules/$.species")(Array);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.promise", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.ctx", "npm:core-js@0.9.6/modules/$.cof", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.assert", "npm:core-js@0.9.6/modules/$.for-of", "npm:core-js@0.9.6/modules/$.set-proto", "npm:core-js@0.9.6/modules/$.species", "npm:core-js@0.9.6/modules/$.wks", "npm:core-js@0.9.6/modules/$.uid", "npm:core-js@0.9.6/modules/$.task", "npm:core-js@0.9.6/modules/$.iter-detect", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var $ = require("npm:core-js@0.9.6/modules/$"),
        ctx = require("npm:core-js@0.9.6/modules/$.ctx"),
        cof = require("npm:core-js@0.9.6/modules/$.cof"),
        $def = require("npm:core-js@0.9.6/modules/$.def"),
        assert = require("npm:core-js@0.9.6/modules/$.assert"),
        forOf = require("npm:core-js@0.9.6/modules/$.for-of"),
        setProto = require("npm:core-js@0.9.6/modules/$.set-proto").set,
        species = require("npm:core-js@0.9.6/modules/$.species"),
        SPECIES = require("npm:core-js@0.9.6/modules/$.wks")('species'),
        RECORD = require("npm:core-js@0.9.6/modules/$.uid").safe('record'),
        PROMISE = 'Promise',
        global = $.g,
        process = global.process,
        asap = process && process.nextTick || require("npm:core-js@0.9.6/modules/$.task").set,
        P = global[PROMISE],
        isFunction = $.isFunction,
        isObject = $.isObject,
        assertFunction = assert.fn,
        assertObject = assert.obj;
    var useNative = function() {
      var test,
          works = false;
      function P2(x) {
        var self = new P(x);
        setProto(self, P2.prototype);
        return self;
      }
      try {
        works = isFunction(P) && isFunction(P.resolve) && P.resolve(test = new P(function() {})) == test;
        setProto(P2, P);
        P2.prototype = $.create(P.prototype, {constructor: {value: P2}});
        if (!(P2.resolve(5).then(function() {}) instanceof P2)) {
          works = false;
        }
      } catch (e) {
        works = false;
      }
      return works;
    }();
    function getConstructor(C) {
      var S = assertObject(C)[SPECIES];
      return S != undefined ? S : C;
    }
    function isThenable(it) {
      var then;
      if (isObject(it))
        then = it.then;
      return isFunction(then) ? then : false;
    }
    function notify(record) {
      var chain = record.c;
      if (chain.length)
        asap(function() {
          var value = record.v,
              ok = record.s == 1,
              i = 0;
          function run(react) {
            var cb = ok ? react.ok : react.fail,
                ret,
                then;
            try {
              if (cb) {
                if (!ok)
                  record.h = true;
                ret = cb === true ? value : cb(value);
                if (ret === react.P) {
                  react.rej(TypeError('Promise-chain cycle'));
                } else if (then = isThenable(ret)) {
                  then.call(ret, react.res, react.rej);
                } else
                  react.res(ret);
              } else
                react.rej(value);
            } catch (err) {
              react.rej(err);
            }
          }
          while (chain.length > i)
            run(chain[i++]);
          chain.length = 0;
        });
    }
    function isUnhandled(promise) {
      var record = promise[RECORD],
          chain = record.a || record.c,
          i = 0,
          react;
      if (record.h)
        return false;
      while (chain.length > i) {
        react = chain[i++];
        if (react.fail || !isUnhandled(react.P))
          return false;
      }
      return true;
    }
    function $reject(value) {
      var record = this,
          promise;
      if (record.d)
        return ;
      record.d = true;
      record = record.r || record;
      record.v = value;
      record.s = 2;
      record.a = record.c.slice();
      setTimeout(function() {
        asap(function() {
          if (isUnhandled(promise = record.p)) {
            if (cof(process) == 'process') {
              process.emit('unhandledRejection', value, promise);
            } else if (global.console && isFunction(console.error)) {
              console.error('Unhandled promise rejection', value);
            }
          }
          record.a = undefined;
        });
      }, 1);
      notify(record);
    }
    function $resolve(value) {
      var record = this,
          then,
          wrapper;
      if (record.d)
        return ;
      record.d = true;
      record = record.r || record;
      try {
        if (then = isThenable(value)) {
          wrapper = {
            r: record,
            d: false
          };
          then.call(value, ctx($resolve, wrapper, 1), ctx($reject, wrapper, 1));
        } else {
          record.v = value;
          record.s = 1;
          notify(record);
        }
      } catch (err) {
        $reject.call(wrapper || {
          r: record,
          d: false
        }, err);
      }
    }
    if (!useNative) {
      P = function Promise(executor) {
        assertFunction(executor);
        var record = {
          p: assert.inst(this, P, PROMISE),
          c: [],
          a: undefined,
          s: 0,
          d: false,
          v: undefined,
          h: false
        };
        $.hide(this, RECORD, record);
        try {
          executor(ctx($resolve, record, 1), ctx($reject, record, 1));
        } catch (err) {
          $reject.call(record, err);
        }
      };
      $.mix(P.prototype, {
        then: function then(onFulfilled, onRejected) {
          var S = assertObject(assertObject(this).constructor)[SPECIES];
          var react = {
            ok: isFunction(onFulfilled) ? onFulfilled : true,
            fail: isFunction(onRejected) ? onRejected : false
          };
          var promise = react.P = new (S != undefined ? S : P)(function(res, rej) {
            react.res = assertFunction(res);
            react.rej = assertFunction(rej);
          });
          var record = this[RECORD];
          record.c.push(react);
          if (record.a)
            record.a.push(react);
          record.s && notify(record);
          return promise;
        },
        'catch': function(onRejected) {
          return this.then(undefined, onRejected);
        }
      });
    }
    $def($def.G + $def.W + $def.F * !useNative, {Promise: P});
    cof.set(P, PROMISE);
    species(P);
    species($.core[PROMISE]);
    $def($def.S + $def.F * !useNative, PROMISE, {
      reject: function reject(r) {
        return new (getConstructor(this))(function(res, rej) {
          rej(r);
        });
      },
      resolve: function resolve(x) {
        return isObject(x) && RECORD in x && $.getProto(x) === this.prototype ? x : new (getConstructor(this))(function(res) {
          res(x);
        });
      }
    });
    $def($def.S + $def.F * !(useNative && require("npm:core-js@0.9.6/modules/$.iter-detect")(function(iter) {
      P.all(iter)['catch'](function() {});
    })), PROMISE, {
      all: function all(iterable) {
        var C = getConstructor(this),
            values = [];
        return new C(function(res, rej) {
          forOf(iterable, false, values.push, values);
          var remaining = values.length,
              results = Array(remaining);
          if (remaining)
            $.each.call(values, function(promise, index) {
              C.resolve(promise).then(function(value) {
                results[index] = value;
                --remaining || res(results);
              }, rej);
            });
          else
            res(results);
        });
      },
      race: function race(iterable) {
        var C = getConstructor(this);
        return new C(function(res, rej) {
          forOf(iterable, false, function(promise) {
            C.resolve(promise).then(res, rej);
          });
        });
      }
    });
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.map", ["npm:core-js@0.9.6/modules/$.collection-strong", "npm:core-js@0.9.6/modules/$.collection"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var strong = require("npm:core-js@0.9.6/modules/$.collection-strong");
  require("npm:core-js@0.9.6/modules/$.collection")('Map', {
    get: function get(key) {
      var entry = strong.getEntry(this, key);
      return entry && entry.v;
    },
    set: function set(key, value) {
      return strong.def(this, key === 0 ? 0 : key, value);
    }
  }, strong, true);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.weak-map", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.collection-weak", "npm:core-js@0.9.6/modules/$.collection"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/modules/$"),
      weak = require("npm:core-js@0.9.6/modules/$.collection-weak"),
      leakStore = weak.leakStore,
      ID = weak.ID,
      WEAK = weak.WEAK,
      has = $.has,
      isObject = $.isObject,
      isFrozen = Object.isFrozen || $.core.Object.isFrozen,
      tmp = {};
  var WeakMap = require("npm:core-js@0.9.6/modules/$.collection")('WeakMap', {
    get: function get(key) {
      if (isObject(key)) {
        if (isFrozen(key))
          return leakStore(this).get(key);
        if (has(key, WEAK))
          return key[WEAK][this[ID]];
      }
    },
    set: function set(key, value) {
      return weak.def(this, key, value);
    }
  }, weak, true, true);
  if ($.FW && new WeakMap().set((Object.freeze || Object)(tmp), 7).get(tmp) != 7) {
    $.each.call(['delete', 'has', 'get', 'set'], function(key) {
      var method = WeakMap.prototype[key];
      WeakMap.prototype[key] = function(a, b) {
        if (isObject(a) && isFrozen(a)) {
          var result = leakStore(this)[key](a, b);
          return key == 'set' ? this : result;
        }
        return method.call(this, a, b);
      };
    });
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es6.reflect", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.set-proto", "npm:core-js@0.9.6/modules/$.iter", "npm:core-js@0.9.6/modules/$.wks", "npm:core-js@0.9.6/modules/$.uid", "npm:core-js@0.9.6/modules/$.assert", "npm:core-js@0.9.6/modules/$.own-keys"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      setProto = require("npm:core-js@0.9.6/modules/$.set-proto"),
      $iter = require("npm:core-js@0.9.6/modules/$.iter"),
      ITERATOR = require("npm:core-js@0.9.6/modules/$.wks")('iterator'),
      ITER = require("npm:core-js@0.9.6/modules/$.uid").safe('iter'),
      step = $iter.step,
      assert = require("npm:core-js@0.9.6/modules/$.assert"),
      isObject = $.isObject,
      getProto = $.getProto,
      $Reflect = $.g.Reflect,
      _apply = Function.apply,
      assertObject = assert.obj,
      _isExtensible = Object.isExtensible || $.isObject,
      _preventExtensions = Object.preventExtensions || $.it,
      buggyEnumerate = !($Reflect && $Reflect.enumerate && ITERATOR in $Reflect.enumerate({}));
  function Enumerate(iterated) {
    $.set(this, ITER, {
      o: iterated,
      k: undefined,
      i: 0
    });
  }
  $iter.create(Enumerate, 'Object', function() {
    var iter = this[ITER],
        keys = iter.k,
        key;
    if (keys == undefined) {
      iter.k = keys = [];
      for (key in iter.o)
        keys.push(key);
    }
    do {
      if (iter.i >= keys.length)
        return step(1);
    } while (!((key = keys[iter.i++]) in iter.o));
    return step(0, key);
  });
  var reflect = {
    apply: function apply(target, thisArgument, argumentsList) {
      return _apply.call(target, thisArgument, argumentsList);
    },
    construct: function construct(target, argumentsList) {
      var proto = assert.fn(arguments.length < 3 ? target : arguments[2]).prototype,
          instance = $.create(isObject(proto) ? proto : Object.prototype),
          result = _apply.call(target, instance, argumentsList);
      return isObject(result) ? result : instance;
    },
    defineProperty: function defineProperty(target, propertyKey, attributes) {
      assertObject(target);
      try {
        $.setDesc(target, propertyKey, attributes);
        return true;
      } catch (e) {
        return false;
      }
    },
    deleteProperty: function deleteProperty(target, propertyKey) {
      var desc = $.getDesc(assertObject(target), propertyKey);
      return desc && !desc.configurable ? false : delete target[propertyKey];
    },
    get: function get(target, propertyKey) {
      var receiver = arguments.length < 3 ? target : arguments[2],
          desc = $.getDesc(assertObject(target), propertyKey),
          proto;
      if (desc)
        return $.has(desc, 'value') ? desc.value : desc.get === undefined ? undefined : desc.get.call(receiver);
      return isObject(proto = getProto(target)) ? get(proto, propertyKey, receiver) : undefined;
    },
    getOwnPropertyDescriptor: function getOwnPropertyDescriptor(target, propertyKey) {
      return $.getDesc(assertObject(target), propertyKey);
    },
    getPrototypeOf: function getPrototypeOf(target) {
      return getProto(assertObject(target));
    },
    has: function has(target, propertyKey) {
      return propertyKey in target;
    },
    isExtensible: function isExtensible(target) {
      return _isExtensible(assertObject(target));
    },
    ownKeys: require("npm:core-js@0.9.6/modules/$.own-keys"),
    preventExtensions: function preventExtensions(target) {
      assertObject(target);
      try {
        _preventExtensions(target);
        return true;
      } catch (e) {
        return false;
      }
    },
    set: function set(target, propertyKey, V) {
      var receiver = arguments.length < 4 ? target : arguments[3],
          ownDesc = $.getDesc(assertObject(target), propertyKey),
          existingDescriptor,
          proto;
      if (!ownDesc) {
        if (isObject(proto = getProto(target))) {
          return set(proto, propertyKey, V, receiver);
        }
        ownDesc = $.desc(0);
      }
      if ($.has(ownDesc, 'value')) {
        if (ownDesc.writable === false || !isObject(receiver))
          return false;
        existingDescriptor = $.getDesc(receiver, propertyKey) || $.desc(0);
        existingDescriptor.value = V;
        $.setDesc(receiver, propertyKey, existingDescriptor);
        return true;
      }
      return ownDesc.set === undefined ? false : (ownDesc.set.call(receiver, V), true);
    }
  };
  if (setProto)
    reflect.setPrototypeOf = function setPrototypeOf(target, proto) {
      setProto.check(target, proto);
      try {
        setProto.set(target, proto);
        return true;
      } catch (e) {
        return false;
      }
    };
  $def($def.G, {Reflect: {}});
  $def($def.S + $def.F * buggyEnumerate, 'Reflect', {enumerate: function enumerate(target) {
      return new Enumerate(assertObject(target));
    }});
  $def($def.S, 'Reflect', reflect);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es7.string.lpad", ["npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.string-pad"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $def = require("npm:core-js@0.9.6/modules/$.def"),
      $pad = require("npm:core-js@0.9.6/modules/$.string-pad");
  $def($def.P, 'String', {lpad: function lpad(n) {
      return $pad(this, n, arguments[1], true);
    }});
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es7.map.to-json", ["npm:core-js@0.9.6/modules/$.collection-to-json"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/modules/$.collection-to-json")('Map');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/web.timers", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.invoke", "npm:core-js@0.9.6/modules/$.partial"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      invoke = require("npm:core-js@0.9.6/modules/$.invoke"),
      partial = require("npm:core-js@0.9.6/modules/$.partial"),
      navigator = $.g.navigator,
      MSIE = !!navigator && /MSIE .\./.test(navigator.userAgent);
  function wrap(set) {
    return MSIE ? function(fn, time) {
      return set(invoke(partial, [].slice.call(arguments, 2), $.isFunction(fn) ? fn : Function(fn)), time);
    } : set;
  }
  $def($def.G + $def.B + $def.F * MSIE, {
    setTimeout: wrap($.g.setTimeout),
    setInterval: wrap($.g.setInterval)
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/es6.symbol", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.cof", "npm:core-js@0.9.6/library/modules/$.uid", "npm:core-js@0.9.6/library/modules/$.def", "npm:core-js@0.9.6/library/modules/$.keyof", "npm:core-js@0.9.6/library/modules/$.enum-keys", "npm:core-js@0.9.6/library/modules/$.assert", "npm:core-js@0.9.6/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      setTag = require("npm:core-js@0.9.6/library/modules/$.cof").set,
      uid = require("npm:core-js@0.9.6/library/modules/$.uid"),
      $def = require("npm:core-js@0.9.6/library/modules/$.def"),
      keyOf = require("npm:core-js@0.9.6/library/modules/$.keyof"),
      enumKeys = require("npm:core-js@0.9.6/library/modules/$.enum-keys"),
      assertObject = require("npm:core-js@0.9.6/library/modules/$.assert").obj,
      has = $.has,
      $create = $.create,
      getDesc = $.getDesc,
      setDesc = $.setDesc,
      desc = $.desc,
      getNames = $.getNames,
      toObject = $.toObject,
      $Symbol = $.g.Symbol,
      setter = false,
      TAG = uid('tag'),
      HIDDEN = uid('hidden'),
      SymbolRegistry = {},
      AllSymbols = {},
      useNative = $.isFunction($Symbol);
  function wrap(tag) {
    var sym = AllSymbols[tag] = $.set($create($Symbol.prototype), TAG, tag);
    $.DESC && setter && setDesc(Object.prototype, tag, {
      configurable: true,
      set: function(value) {
        if (has(this, HIDDEN) && has(this[HIDDEN], tag))
          this[HIDDEN][tag] = false;
        setDesc(this, tag, desc(1, value));
      }
    });
    return sym;
  }
  function defineProperty(it, key, D) {
    if (D && has(AllSymbols, key)) {
      if (!D.enumerable) {
        if (!has(it, HIDDEN))
          setDesc(it, HIDDEN, desc(1, {}));
        it[HIDDEN][key] = true;
      } else {
        if (has(it, HIDDEN) && it[HIDDEN][key])
          it[HIDDEN][key] = false;
        D.enumerable = false;
      }
    }
    return setDesc(it, key, D);
  }
  function defineProperties(it, P) {
    assertObject(it);
    var keys = enumKeys(P = toObject(P)),
        i = 0,
        l = keys.length,
        key;
    while (l > i)
      defineProperty(it, key = keys[i++], P[key]);
    return it;
  }
  function create(it, P) {
    return P === undefined ? $create(it) : defineProperties($create(it), P);
  }
  function getOwnPropertyDescriptor(it, key) {
    var D = getDesc(it = toObject(it), key);
    if (D && has(AllSymbols, key) && !(has(it, HIDDEN) && it[HIDDEN][key]))
      D.enumerable = true;
    return D;
  }
  function getOwnPropertyNames(it) {
    var names = getNames(toObject(it)),
        result = [],
        i = 0,
        key;
    while (names.length > i)
      if (!has(AllSymbols, key = names[i++]) && key != HIDDEN)
        result.push(key);
    return result;
  }
  function getOwnPropertySymbols(it) {
    var names = getNames(toObject(it)),
        result = [],
        i = 0,
        key;
    while (names.length > i)
      if (has(AllSymbols, key = names[i++]))
        result.push(AllSymbols[key]);
    return result;
  }
  if (!useNative) {
    $Symbol = function Symbol(description) {
      if (this instanceof $Symbol)
        throw TypeError('Symbol is not a constructor');
      return wrap(uid(description));
    };
    $.hide($Symbol.prototype, 'toString', function() {
      return this[TAG];
    });
    $.create = create;
    $.setDesc = defineProperty;
    $.getDesc = getOwnPropertyDescriptor;
    $.setDescs = defineProperties;
    $.getNames = getOwnPropertyNames;
    $.getSymbols = getOwnPropertySymbols;
  }
  var symbolStatics = {
    'for': function(key) {
      return has(SymbolRegistry, key += '') ? SymbolRegistry[key] : SymbolRegistry[key] = $Symbol(key);
    },
    keyFor: function keyFor(key) {
      return keyOf(SymbolRegistry, key);
    },
    useSetter: function() {
      setter = true;
    },
    useSimple: function() {
      setter = false;
    }
  };
  $.each.call(('hasInstance,isConcatSpreadable,iterator,match,replace,search,' + 'species,split,toPrimitive,toStringTag,unscopables').split(','), function(it) {
    var sym = require("npm:core-js@0.9.6/library/modules/$.wks")(it);
    symbolStatics[it] = useNative ? sym : wrap(sym);
  });
  setter = true;
  $def($def.G + $def.W, {Symbol: $Symbol});
  $def($def.S, 'Symbol', symbolStatics);
  $def($def.S + $def.F * !useNative, 'Object', {
    create: create,
    defineProperty: defineProperty,
    defineProperties: defineProperties,
    getOwnPropertyDescriptor: getOwnPropertyDescriptor,
    getOwnPropertyNames: getOwnPropertyNames,
    getOwnPropertySymbols: getOwnPropertySymbols
  });
  setTag($Symbol, 'Symbol');
  setTag(Math, 'Math', true);
  setTag($.g.JSON, 'JSON', true);
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/core-js/symbol/iterator", ["npm:core-js@0.9.6/library/fn/symbol/iterator"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.6/library/fn/symbol/iterator"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/core-js/object/create", ["npm:core-js@0.9.6/library/fn/object/create"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.6/library/fn/object/create"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

(function() {
function define(){};  define.amd = {};
System.register("github:components/jquery@2.1.3", ["github:components/jquery@2.1.3/jquery"], false, function(__require, __exports, __module) {
  return (function(main) {
    return main;
  }).call(this, __require('github:components/jquery@2.1.3/jquery'));
});
})();
System.register("npm:babel-runtime@5.2.9/core-js/object/define-property", ["npm:core-js@0.9.6/library/fn/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.6/library/fn/object/define-property"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:base64-js@0.0.8", ["npm:base64-js@0.0.8/lib/b64"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:base64-js@0.0.8/lib/b64");
  global.define = __define;
  return module.exports;
});

System.register("npm:ieee754@1.1.5", ["npm:ieee754@1.1.5/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:ieee754@1.1.5/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:is-array@1.0.1", ["npm:is-array@1.0.1/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:is-array@1.0.1/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:inherits@2.0.1", ["npm:inherits@2.0.1/inherits_browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:inherits@2.0.1/inherits_browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:create-hash@1.1.1/md5", ["npm:create-hash@1.1.1/helpers"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var helpers = require("npm:create-hash@1.1.1/helpers");
  function core_md5(x, len) {
    x[len >> 5] |= 0x80 << ((len) % 32);
    x[(((len + 64) >>> 9) << 4) + 14] = len;
    var a = 1732584193;
    var b = -271733879;
    var c = -1732584194;
    var d = 271733878;
    for (var i = 0; i < x.length; i += 16) {
      var olda = a;
      var oldb = b;
      var oldc = c;
      var oldd = d;
      a = md5_ff(a, b, c, d, x[i + 0], 7, -680876936);
      d = md5_ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = md5_ff(c, d, a, b, x[i + 2], 17, 606105819);
      b = md5_ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = md5_ff(a, b, c, d, x[i + 4], 7, -176418897);
      d = md5_ff(d, a, b, c, x[i + 5], 12, 1200080426);
      c = md5_ff(c, d, a, b, x[i + 6], 17, -1473231341);
      b = md5_ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = md5_ff(a, b, c, d, x[i + 8], 7, 1770035416);
      d = md5_ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = md5_ff(c, d, a, b, x[i + 10], 17, -42063);
      b = md5_ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = md5_ff(a, b, c, d, x[i + 12], 7, 1804603682);
      d = md5_ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = md5_ff(c, d, a, b, x[i + 14], 17, -1502002290);
      b = md5_ff(b, c, d, a, x[i + 15], 22, 1236535329);
      a = md5_gg(a, b, c, d, x[i + 1], 5, -165796510);
      d = md5_gg(d, a, b, c, x[i + 6], 9, -1069501632);
      c = md5_gg(c, d, a, b, x[i + 11], 14, 643717713);
      b = md5_gg(b, c, d, a, x[i + 0], 20, -373897302);
      a = md5_gg(a, b, c, d, x[i + 5], 5, -701558691);
      d = md5_gg(d, a, b, c, x[i + 10], 9, 38016083);
      c = md5_gg(c, d, a, b, x[i + 15], 14, -660478335);
      b = md5_gg(b, c, d, a, x[i + 4], 20, -405537848);
      a = md5_gg(a, b, c, d, x[i + 9], 5, 568446438);
      d = md5_gg(d, a, b, c, x[i + 14], 9, -1019803690);
      c = md5_gg(c, d, a, b, x[i + 3], 14, -187363961);
      b = md5_gg(b, c, d, a, x[i + 8], 20, 1163531501);
      a = md5_gg(a, b, c, d, x[i + 13], 5, -1444681467);
      d = md5_gg(d, a, b, c, x[i + 2], 9, -51403784);
      c = md5_gg(c, d, a, b, x[i + 7], 14, 1735328473);
      b = md5_gg(b, c, d, a, x[i + 12], 20, -1926607734);
      a = md5_hh(a, b, c, d, x[i + 5], 4, -378558);
      d = md5_hh(d, a, b, c, x[i + 8], 11, -2022574463);
      c = md5_hh(c, d, a, b, x[i + 11], 16, 1839030562);
      b = md5_hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = md5_hh(a, b, c, d, x[i + 1], 4, -1530992060);
      d = md5_hh(d, a, b, c, x[i + 4], 11, 1272893353);
      c = md5_hh(c, d, a, b, x[i + 7], 16, -155497632);
      b = md5_hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = md5_hh(a, b, c, d, x[i + 13], 4, 681279174);
      d = md5_hh(d, a, b, c, x[i + 0], 11, -358537222);
      c = md5_hh(c, d, a, b, x[i + 3], 16, -722521979);
      b = md5_hh(b, c, d, a, x[i + 6], 23, 76029189);
      a = md5_hh(a, b, c, d, x[i + 9], 4, -640364487);
      d = md5_hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = md5_hh(c, d, a, b, x[i + 15], 16, 530742520);
      b = md5_hh(b, c, d, a, x[i + 2], 23, -995338651);
      a = md5_ii(a, b, c, d, x[i + 0], 6, -198630844);
      d = md5_ii(d, a, b, c, x[i + 7], 10, 1126891415);
      c = md5_ii(c, d, a, b, x[i + 14], 15, -1416354905);
      b = md5_ii(b, c, d, a, x[i + 5], 21, -57434055);
      a = md5_ii(a, b, c, d, x[i + 12], 6, 1700485571);
      d = md5_ii(d, a, b, c, x[i + 3], 10, -1894986606);
      c = md5_ii(c, d, a, b, x[i + 10], 15, -1051523);
      b = md5_ii(b, c, d, a, x[i + 1], 21, -2054922799);
      a = md5_ii(a, b, c, d, x[i + 8], 6, 1873313359);
      d = md5_ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = md5_ii(c, d, a, b, x[i + 6], 15, -1560198380);
      b = md5_ii(b, c, d, a, x[i + 13], 21, 1309151649);
      a = md5_ii(a, b, c, d, x[i + 4], 6, -145523070);
      d = md5_ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = md5_ii(c, d, a, b, x[i + 2], 15, 718787259);
      b = md5_ii(b, c, d, a, x[i + 9], 21, -343485551);
      a = safe_add(a, olda);
      b = safe_add(b, oldb);
      c = safe_add(c, oldc);
      d = safe_add(d, oldd);
    }
    return Array(a, b, c, d);
  }
  function md5_cmn(q, a, b, x, s, t) {
    return safe_add(bit_rol(safe_add(safe_add(a, q), safe_add(x, t)), s), b);
  }
  function md5_ff(a, b, c, d, x, s, t) {
    return md5_cmn((b & c) | ((~b) & d), a, b, x, s, t);
  }
  function md5_gg(a, b, c, d, x, s, t) {
    return md5_cmn((b & d) | (c & (~d)), a, b, x, s, t);
  }
  function md5_hh(a, b, c, d, x, s, t) {
    return md5_cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function md5_ii(a, b, c, d, x, s, t) {
    return md5_cmn(c ^ (b | (~d)), a, b, x, s, t);
  }
  function safe_add(x, y) {
    var lsw = (x & 0xFFFF) + (y & 0xFFFF);
    var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xFFFF);
  }
  function bit_rol(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }
  module.exports = function md5(buf) {
    return helpers.hash(buf, core_md5, 16);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:ripemd160@1.0.0", ["npm:ripemd160@1.0.0/lib/ripemd160"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:ripemd160@1.0.0/lib/ripemd160");
  global.define = __define;
  return module.exports;
});

System.register("npm:sha.js@2.4.0/sha", ["npm:inherits@2.0.1", "npm:sha.js@2.4.0/hash", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var inherits = require("npm:inherits@2.0.1");
    var Hash = require("npm:sha.js@2.4.0/hash");
    var W = new Array(80);
    function Sha() {
      this.init();
      this._w = W;
      Hash.call(this, 64, 56);
    }
    inherits(Sha, Hash);
    Sha.prototype.init = function() {
      this._a = 0x67452301;
      this._b = 0xefcdab89;
      this._c = 0x98badcfe;
      this._d = 0x10325476;
      this._e = 0xc3d2e1f0;
      return this;
    };
    function rol(num, cnt) {
      return (num << cnt) | (num >>> (32 - cnt));
    }
    Sha.prototype._update = function(M) {
      var W = this._w;
      var a = this._a;
      var b = this._b;
      var c = this._c;
      var d = this._d;
      var e = this._e;
      var j = 0,
          k;
      function calcW() {
        return W[j - 3] ^ W[j - 8] ^ W[j - 14] ^ W[j - 16];
      }
      function loop(w, f) {
        W[j] = w;
        var t = rol(a, 5) + f + e + w + k;
        e = d;
        d = c;
        c = rol(b, 30);
        b = a;
        a = t;
        j++;
      }
      k = 1518500249;
      while (j < 16)
        loop(M.readInt32BE(j * 4), (b & c) | ((~b) & d));
      while (j < 20)
        loop(calcW(), (b & c) | ((~b) & d));
      k = 1859775393;
      while (j < 40)
        loop(calcW(), b ^ c ^ d);
      k = -1894007588;
      while (j < 60)
        loop(calcW(), (b & c) | (b & d) | (c & d));
      k = -899497514;
      while (j < 80)
        loop(calcW(), b ^ c ^ d);
      this._a = (a + this._a) | 0;
      this._b = (b + this._b) | 0;
      this._c = (c + this._c) | 0;
      this._d = (d + this._d) | 0;
      this._e = (e + this._e) | 0;
    };
    Sha.prototype._hash = function() {
      var H = new Buffer(20);
      H.writeInt32BE(this._a | 0, 0);
      H.writeInt32BE(this._b | 0, 4);
      H.writeInt32BE(this._c | 0, 8);
      H.writeInt32BE(this._d | 0, 12);
      H.writeInt32BE(this._e | 0, 16);
      return H;
    };
    module.exports = Sha;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:sha.js@2.4.0/sha224", ["npm:inherits@2.0.1", "npm:sha.js@2.4.0/sha256", "npm:sha.js@2.4.0/hash", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var inherits = require("npm:inherits@2.0.1");
    var SHA256 = require("npm:sha.js@2.4.0/sha256");
    var Hash = require("npm:sha.js@2.4.0/hash");
    var W = new Array(64);
    function Sha224() {
      this.init();
      this._w = W;
      Hash.call(this, 64, 56);
    }
    inherits(Sha224, SHA256);
    Sha224.prototype.init = function() {
      this._a = 0xc1059ed8 | 0;
      this._b = 0x367cd507 | 0;
      this._c = 0x3070dd17 | 0;
      this._d = 0xf70e5939 | 0;
      this._e = 0xffc00b31 | 0;
      this._f = 0x68581511 | 0;
      this._g = 0x64f98fa7 | 0;
      this._h = 0xbefa4fa4 | 0;
      return this;
    };
    Sha224.prototype._hash = function() {
      var H = new Buffer(28);
      H.writeInt32BE(this._a, 0);
      H.writeInt32BE(this._b, 4);
      H.writeInt32BE(this._c, 8);
      H.writeInt32BE(this._d, 12);
      H.writeInt32BE(this._e, 16);
      H.writeInt32BE(this._f, 20);
      H.writeInt32BE(this._g, 24);
      return H;
    };
    module.exports = Sha224;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:sha.js@2.4.0/sha384", ["npm:inherits@2.0.1", "npm:sha.js@2.4.0/sha512", "npm:sha.js@2.4.0/hash", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var inherits = require("npm:inherits@2.0.1");
    var SHA512 = require("npm:sha.js@2.4.0/sha512");
    var Hash = require("npm:sha.js@2.4.0/hash");
    var W = new Array(160);
    function Sha384() {
      this.init();
      this._w = W;
      Hash.call(this, 128, 112);
    }
    inherits(Sha384, SHA512);
    Sha384.prototype.init = function() {
      this._a = 0xcbbb9d5d | 0;
      this._b = 0x629a292a | 0;
      this._c = 0x9159015a | 0;
      this._d = 0x152fecd8 | 0;
      this._e = 0x67332667 | 0;
      this._f = 0x8eb44a87 | 0;
      this._g = 0xdb0c2e0d | 0;
      this._h = 0x47b5481d | 0;
      this._al = 0xc1059ed8 | 0;
      this._bl = 0x367cd507 | 0;
      this._cl = 0x3070dd17 | 0;
      this._dl = 0xf70e5939 | 0;
      this._el = 0xffc00b31 | 0;
      this._fl = 0x68581511 | 0;
      this._gl = 0x64f98fa7 | 0;
      this._hl = 0xbefa4fa4 | 0;
      return this;
    };
    Sha384.prototype._hash = function() {
      var H = new Buffer(48);
      function writeInt64BE(h, l, offset) {
        H.writeInt32BE(h, offset);
        H.writeInt32BE(l, offset + 4);
      }
      writeInt64BE(this._a, this._al, 0);
      writeInt64BE(this._b, this._bl, 8);
      writeInt64BE(this._c, this._cl, 16);
      writeInt64BE(this._d, this._dl, 24);
      writeInt64BE(this._e, this._el, 32);
      writeInt64BE(this._f, this._fl, 40);
      return H;
    };
    module.exports = Sha384;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:events-browserify@0.0.1", ["npm:events-browserify@0.0.1/events"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:events-browserify@0.0.1/events");
  global.define = __define;
  return module.exports;
});

System.register("npm:isarray@0.0.1", ["npm:isarray@0.0.1/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:isarray@0.0.1/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-util-is@1.0.1", ["npm:core-util-is@1.0.1/lib/util"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:core-util-is@1.0.1/lib/util");
  global.define = __define;
  return module.exports;
});

System.register("npm:readable-stream@1.1.13/lib/_stream_duplex", ["npm:core-util-is@1.0.1", "npm:inherits@2.0.1", "npm:readable-stream@1.1.13/lib/_stream_readable", "npm:readable-stream@1.1.13/lib/_stream_writable", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    module.exports = Duplex;
    var objectKeys = Object.keys || function(obj) {
      var keys = [];
      for (var key in obj)
        keys.push(key);
      return keys;
    };
    var util = require("npm:core-util-is@1.0.1");
    util.inherits = require("npm:inherits@2.0.1");
    var Readable = require("npm:readable-stream@1.1.13/lib/_stream_readable");
    var Writable = require("npm:readable-stream@1.1.13/lib/_stream_writable");
    util.inherits(Duplex, Readable);
    forEach(objectKeys(Writable.prototype), function(method) {
      if (!Duplex.prototype[method])
        Duplex.prototype[method] = Writable.prototype[method];
    });
    function Duplex(options) {
      if (!(this instanceof Duplex))
        return new Duplex(options);
      Readable.call(this, options);
      Writable.call(this, options);
      if (options && options.readable === false)
        this.readable = false;
      if (options && options.writable === false)
        this.writable = false;
      this.allowHalfOpen = true;
      if (options && options.allowHalfOpen === false)
        this.allowHalfOpen = false;
      this.once('end', onend);
    }
    function onend() {
      if (this.allowHalfOpen || this._writableState.ended)
        return ;
      process.nextTick(this.end.bind(this));
    }
    function forEach(xs, f) {
      for (var i = 0,
          l = xs.length; i < l; i++) {
        f(xs[i], i);
      }
    }
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:string_decoder@0.10.31", ["npm:string_decoder@0.10.31/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:string_decoder@0.10.31/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:create-hmac@1.1.3", ["npm:create-hmac@1.1.3/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:create-hmac@1.1.3/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:pbkdf2@3.0.4", ["npm:pbkdf2@3.0.4/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:pbkdf2@3.0.4/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/authCipher", ["npm:browserify-aes@1.0.0/aes", "npm:browserify-aes@1.0.0/cipherBase", "npm:inherits@2.0.1", "npm:browserify-aes@1.0.0/ghash", "npm:browserify-aes@1.0.0/xor", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var aes = require("npm:browserify-aes@1.0.0/aes");
    var Transform = require("npm:browserify-aes@1.0.0/cipherBase");
    var inherits = require("npm:inherits@2.0.1");
    var GHASH = require("npm:browserify-aes@1.0.0/ghash");
    var xor = require("npm:browserify-aes@1.0.0/xor");
    inherits(StreamCipher, Transform);
    module.exports = StreamCipher;
    function StreamCipher(mode, key, iv, decrypt) {
      if (!(this instanceof StreamCipher)) {
        return new StreamCipher(mode, key, iv);
      }
      Transform.call(this);
      this._finID = Buffer.concat([iv, new Buffer([0, 0, 0, 1])]);
      iv = Buffer.concat([iv, new Buffer([0, 0, 0, 2])]);
      this._cipher = new aes.AES(key);
      this._prev = new Buffer(iv.length);
      this._cache = new Buffer('');
      this._secCache = new Buffer('');
      this._decrypt = decrypt;
      this._alen = 0;
      this._len = 0;
      iv.copy(this._prev);
      this._mode = mode;
      var h = new Buffer(4);
      h.fill(0);
      this._ghash = new GHASH(this._cipher.encryptBlock(h));
      this._authTag = null;
      this._called = false;
    }
    StreamCipher.prototype._update = function(chunk) {
      if (!this._called && this._alen) {
        var rump = 16 - (this._alen % 16);
        if (rump < 16) {
          rump = new Buffer(rump);
          rump.fill(0);
          this._ghash.update(rump);
        }
      }
      this._called = true;
      var out = this._mode.encrypt(this, chunk);
      if (this._decrypt) {
        this._ghash.update(chunk);
      } else {
        this._ghash.update(out);
      }
      this._len += chunk.length;
      return out;
    };
    StreamCipher.prototype._final = function() {
      if (this._decrypt && !this._authTag) {
        throw new Error('Unsupported state or unable to authenticate data');
      }
      var tag = xor(this._ghash.final(this._alen * 8, this._len * 8), this._cipher.encryptBlock(this._finID));
      if (this._decrypt) {
        if (xorTest(tag, this._authTag)) {
          throw new Error('Unsupported state or unable to authenticate data');
        }
      } else {
        this._authTag = tag;
      }
      this._cipher.scrub();
    };
    StreamCipher.prototype.getAuthTag = function getAuthTag() {
      if (!this._decrypt && Buffer.isBuffer(this._authTag)) {
        return this._authTag;
      } else {
        throw new Error('Attempting to get auth tag in unsupported state');
      }
    };
    StreamCipher.prototype.setAuthTag = function setAuthTag(tag) {
      if (this._decrypt) {
        this._authTag = tag;
      } else {
        throw new Error('Attempting to set auth tag in unsupported state');
      }
    };
    StreamCipher.prototype.setAAD = function setAAD(buf) {
      if (!this._called) {
        this._ghash.update(buf);
        this._alen += buf.length;
      } else {
        throw new Error('Attempting to set AAD in unsupported state');
      }
    };
    function xorTest(a, b) {
      var out = 0;
      if (a.length !== b.length) {
        out++;
      }
      var len = Math.min(a.length, b.length);
      var i = -1;
      while (++i < len) {
        out += (a[i] ^ b[i]);
      }
      return out;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:bn.js@1.3.0", ["npm:bn.js@1.3.0/lib/bn"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:bn.js@1.3.0/lib/bn");
  global.define = __define;
  return module.exports;
});

System.register("npm:brorand@1.0.5", ["npm:brorand@1.0.5/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:brorand@1.0.5/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:indexof@0.0.1", ["npm:indexof@0.0.1/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:indexof@0.0.1/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:minimalistic-assert@1.0.0", ["npm:minimalistic-assert@1.0.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:minimalistic-assert@1.0.0/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1/constants/index", ["npm:asn1.js@1.0.4/lib/asn1/constants/der"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var constants = exports;
  constants._reverse = function reverse(map) {
    var res = {};
    Object.keys(map).forEach(function(key) {
      if ((key | 0) == key)
        key = key | 0;
      var value = map[key];
      res[value] = key;
    });
    return res;
  };
  constants.der = require("npm:asn1.js@1.0.4/lib/asn1/constants/der");
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1/decoders/index", ["npm:asn1.js@1.0.4/lib/asn1/decoders/der"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var decoders = exports;
  decoders.der = require("npm:asn1.js@1.0.4/lib/asn1/decoders/der");
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1/encoders/index", ["npm:asn1.js@1.0.4/lib/asn1/encoders/der"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var encoders = exports;
  encoders.der = require("npm:asn1.js@1.0.4/lib/asn1/encoders/der");
  global.define = __define;
  return module.exports;
});

System.register("npm:parse-asn1@3.0.0/fixProc", ["npm:parse-asn1@3.0.0/EVP_BytesToKey", "npm:browserify-aes@1.0.0", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var findProc = /Proc-Type: 4,ENCRYPTED\n\r?DEK-Info: AES-((?:128)|(?:192)|(?:256))-CBC,([0-9A-H]+)\n\r?\n\r?([0-9A-z\n\r\+\/\=]+)\n\r?/m;
    var startRegex = /^-----BEGIN (.*) KEY-----\n/m;
    var fullRegex = /^-----BEGIN (.*) KEY-----\n\r?([0-9A-z\n\r\+\/\=]+)\n\r?-----END \1 KEY-----$/m;
    var evp = require("npm:parse-asn1@3.0.0/EVP_BytesToKey");
    var ciphers = require("npm:browserify-aes@1.0.0");
    module.exports = function(okey, password) {
      var key = okey.toString();
      var match = key.match(findProc);
      var decrypted;
      if (!match) {
        var match2 = key.match(fullRegex);
        decrypted = new Buffer(match2[2].replace(/\n\r?/g, ''), 'base64');
      } else {
        var suite = 'aes' + match[1];
        var iv = new Buffer(match[2], 'hex');
        var cipherText = new Buffer(match[3].replace(/\n\r?/g, ''), 'base64');
        var cipherKey = evp(password, iv.slice(0, 8), parseInt(match[1]));
        var out = [];
        var cipher = ciphers.createDecipheriv(suite, cipherKey, iv);
        out.push(cipher.update(cipherText));
        out.push(cipher.final());
        decrypted = Buffer.concat(out);
      }
      var tag = key.match(startRegex)[1] + ' KEY';
      return {
        tag: tag,
        data: decrypted
      };
    };
    function wrap(str) {
      var chunks = [];
      while (str) {
        if (str.length < 64) {
          chunks.push(str);
          break;
        } else {
          chunks.push(str.slice(0, 64));
          str = str.slice(64);
        }
      }
      return chunks.join("\n");
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:pbkdf2-compat@3.0.2", ["npm:pbkdf2-compat@3.0.2/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:pbkdf2-compat@3.0.2/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:hash.js@1.0.2/lib/hash", ["npm:hash.js@1.0.2/lib/hash/utils", "npm:hash.js@1.0.2/lib/hash/common", "npm:hash.js@1.0.2/lib/hash/sha", "npm:hash.js@1.0.2/lib/hash/ripemd", "npm:hash.js@1.0.2/lib/hash/hmac"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var hash = exports;
  hash.utils = require("npm:hash.js@1.0.2/lib/hash/utils");
  hash.common = require("npm:hash.js@1.0.2/lib/hash/common");
  hash.sha = require("npm:hash.js@1.0.2/lib/hash/sha");
  hash.ripemd = require("npm:hash.js@1.0.2/lib/hash/ripemd");
  hash.hmac = require("npm:hash.js@1.0.2/lib/hash/hmac");
  hash.sha1 = hash.sha.sha1;
  hash.sha256 = hash.sha.sha256;
  hash.sha224 = hash.sha.sha224;
  hash.sha384 = hash.sha.sha384;
  hash.sha512 = hash.sha.sha512;
  hash.ripemd160 = hash.ripemd.ripemd160;
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic/curve/index", ["npm:elliptic@1.0.1/lib/elliptic/curve/base", "npm:elliptic@1.0.1/lib/elliptic/curve/short", "npm:elliptic@1.0.1/lib/elliptic/curve/mont", "npm:elliptic@1.0.1/lib/elliptic/curve/edwards"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var curve = exports;
  curve.base = require("npm:elliptic@1.0.1/lib/elliptic/curve/base");
  curve.short = require("npm:elliptic@1.0.1/lib/elliptic/curve/short");
  curve.mont = require("npm:elliptic@1.0.1/lib/elliptic/curve/mont");
  curve.edwards = require("npm:elliptic@1.0.1/lib/elliptic/curve/edwards");
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic/ec/index", ["npm:bn.js@1.3.0", "npm:elliptic@1.0.1/lib/elliptic", "npm:elliptic@1.0.1/lib/elliptic/ec/key", "npm:elliptic@1.0.1/lib/elliptic/ec/signature"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var bn = require("npm:bn.js@1.3.0");
  var elliptic = require("npm:elliptic@1.0.1/lib/elliptic");
  var utils = elliptic.utils;
  var assert = utils.assert;
  var KeyPair = require("npm:elliptic@1.0.1/lib/elliptic/ec/key");
  var Signature = require("npm:elliptic@1.0.1/lib/elliptic/ec/signature");
  function EC(options) {
    if (!(this instanceof EC))
      return new EC(options);
    if (typeof options === 'string') {
      assert(elliptic.curves.hasOwnProperty(options), 'Unknown curve ' + options);
      options = elliptic.curves[options];
    }
    if (options instanceof elliptic.curves.PresetCurve)
      options = {curve: options};
    this.curve = options.curve.curve;
    this.n = this.curve.n;
    this.nh = this.n.shrn(1);
    this.g = this.curve.g;
    this.g = options.curve.g;
    this.g.precompute(options.curve.n.bitLength() + 1);
    this.hash = options.hash || options.curve.hash;
  }
  module.exports = EC;
  EC.prototype.keyPair = function keyPair(priv, pub) {
    return new KeyPair(this, priv, pub);
  };
  EC.prototype.genKeyPair = function genKeyPair(options) {
    if (!options)
      options = {};
    var drbg = new elliptic.hmacDRBG({
      hash: this.hash,
      pers: options.pers,
      entropy: options.entropy || elliptic.rand(this.hash.hmacStrength),
      nonce: this.n.toArray()
    });
    var bytes = this.n.byteLength();
    var ns2 = this.n.sub(new bn(2));
    do {
      var priv = new bn(drbg.generate(bytes));
      if (priv.cmp(ns2) > 0)
        continue;
      priv.iaddn(1);
      return this.keyPair(priv);
    } while (true);
  };
  EC.prototype._truncateToN = function truncateToN(msg, truncOnly) {
    var delta = msg.byteLength() * 8 - this.n.bitLength();
    if (delta > 0)
      msg = msg.shrn(delta);
    if (!truncOnly && msg.cmp(this.n) >= 0)
      return msg.sub(this.n);
    else
      return msg;
  };
  EC.prototype.sign = function sign(msg, key, options) {
    key = this.keyPair(key, 'hex');
    msg = this._truncateToN(new bn(msg, 16));
    if (!options)
      options = {};
    var bytes = this.n.byteLength();
    var bkey = key.getPrivate().toArray();
    for (var i = bkey.length; i < 21; i++)
      bkey.unshift(0);
    var nonce = msg.toArray();
    for (var i = nonce.length; i < bytes; i++)
      nonce.unshift(0);
    var drbg = new elliptic.hmacDRBG({
      hash: this.hash,
      entropy: bkey,
      nonce: nonce
    });
    var ns1 = this.n.sub(new bn(1));
    do {
      var k = new bn(drbg.generate(this.n.byteLength()));
      k = this._truncateToN(k, true);
      if (k.cmpn(1) <= 0 || k.cmp(ns1) >= 0)
        continue;
      var kp = this.g.mul(k);
      if (kp.isInfinity())
        continue;
      var r = kp.getX().mod(this.n);
      if (r.cmpn(0) === 0)
        continue;
      var s = k.invm(this.n).mul(r.mul(key.getPrivate()).iadd(msg)).mod(this.n);
      if (s.cmpn(0) === 0)
        continue;
      if (options.canonical && s.cmp(this.nh) > 0)
        s = this.n.sub(s);
      return new Signature(r, s);
    } while (true);
  };
  EC.prototype.verify = function verify(msg, signature, key) {
    msg = this._truncateToN(new bn(msg, 16));
    key = this.keyPair(key, 'hex');
    signature = new Signature(signature, 'hex');
    var r = signature.r;
    var s = signature.s;
    if (r.cmpn(1) < 0 || r.cmp(this.n) >= 0)
      return false;
    if (s.cmpn(1) < 0 || s.cmp(this.n) >= 0)
      return false;
    var sinv = s.invm(this.n);
    var u1 = sinv.mul(msg).mod(this.n);
    var u2 = sinv.mul(r).mod(this.n);
    var p = this.g.mulAdd(u1, key.getPublic(), u2);
    if (p.isInfinity())
      return false;
    return p.getX().mod(this.n).cmp(r) === 0;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-rsa@2.0.0", ["npm:browserify-rsa@2.0.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:browserify-rsa@2.0.0/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:create-ecdh@2.0.0/index", ["github:jspm/nodelibs-crypto@0.1.0", "npm:create-ecdh@2.0.0/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var createECDH = require("github:jspm/nodelibs-crypto@0.1.0").createECDH;
  module.exports = createECDH || require("npm:create-ecdh@2.0.0/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:public-encrypt@2.0.0/publicEncrypt", ["npm:parse-asn1@3.0.0", "npm:randombytes@2.0.1", "npm:create-hash@1.1.1", "npm:public-encrypt@2.0.0/mgf", "npm:public-encrypt@2.0.0/xor", "npm:bn.js@1.3.0", "npm:public-encrypt@2.0.0/withPublic", "npm:browserify-rsa@2.0.0", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var parseKeys = require("npm:parse-asn1@3.0.0");
    var randomBytes = require("npm:randombytes@2.0.1");
    var createHash = require("npm:create-hash@1.1.1");
    var mgf = require("npm:public-encrypt@2.0.0/mgf");
    var xor = require("npm:public-encrypt@2.0.0/xor");
    var bn = require("npm:bn.js@1.3.0");
    var withPublic = require("npm:public-encrypt@2.0.0/withPublic");
    var crt = require("npm:browserify-rsa@2.0.0");
    var constants = {
      RSA_PKCS1_OAEP_PADDING: 4,
      RSA_PKCS1_PADDIN: 1,
      RSA_NO_PADDING: 3
    };
    module.exports = function publicEncrypt(public_key, msg, reverse) {
      var padding;
      if (public_key.padding) {
        padding = public_key.padding;
      } else if (reverse) {
        padding = 1;
      } else {
        padding = 4;
      }
      var key = parseKeys(public_key);
      var paddedMsg;
      if (padding === 4) {
        paddedMsg = oaep(key, msg);
      } else if (padding === 1) {
        paddedMsg = pkcs1(key, msg, reverse);
      } else if (padding === 3) {
        paddedMsg = new bn(msg);
        if (paddedMsg.cmp(key.modulus) >= 0) {
          throw new Error('data too long for modulus');
        }
      } else {
        throw new Error('unknown padding');
      }
      if (reverse) {
        return crt(paddedMsg, key);
      } else {
        return withPublic(paddedMsg, key);
      }
    };
    function oaep(key, msg) {
      var k = key.modulus.byteLength();
      var mLen = msg.length;
      var iHash = createHash('sha1').update(new Buffer('')).digest();
      var hLen = iHash.length;
      var hLen2 = 2 * hLen;
      if (mLen > k - hLen2 - 2) {
        throw new Error('message too long');
      }
      var ps = new Buffer(k - mLen - hLen2 - 2);
      ps.fill(0);
      var dblen = k - hLen - 1;
      var seed = randomBytes(hLen);
      var maskedDb = xor(Buffer.concat([iHash, ps, new Buffer([1]), msg], dblen), mgf(seed, dblen));
      var maskedSeed = xor(seed, mgf(maskedDb, hLen));
      return new bn(Buffer.concat([new Buffer([0]), maskedSeed, maskedDb], k));
    }
    function pkcs1(key, msg, reverse) {
      var mLen = msg.length;
      var k = key.modulus.byteLength();
      if (mLen > k - 11) {
        throw new Error('message too long');
      }
      var ps;
      if (reverse) {
        ps = new Buffer(k - mLen - 3);
        ps.fill(0xff);
      } else {
        ps = nonZero(k - mLen - 3);
      }
      return new bn(Buffer.concat([new Buffer([0, reverse ? 1 : 2]), ps, new Buffer([0]), msg], k));
    }
    function nonZero(len, crypto) {
      var out = new Buffer(len);
      var i = 0;
      var cache = randomBytes(len * 2);
      var cur = 0;
      var num;
      while (i < len) {
        if (cur === cache.length) {
          cache = randomBytes(len * 2);
          cur = 0;
        }
        num = cache[cur++];
        if (num) {
          out[i++] = num;
        }
      }
      return out;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/es6.map", ["npm:core-js@0.9.6/library/modules/$.collection-strong", "npm:core-js@0.9.6/library/modules/$.collection"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var strong = require("npm:core-js@0.9.6/library/modules/$.collection-strong");
  require("npm:core-js@0.9.6/library/modules/$.collection")('Map', {
    get: function get(key) {
      var entry = strong.getEntry(this, key);
      return entry && entry.v;
    },
    set: function set(key, value) {
      return strong.def(this, key === 0 ? 0 : key, value);
    }
  }, strong, true);
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/es7.map.to-json", ["npm:core-js@0.9.6/library/modules/$.collection-to-json"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/library/modules/$.collection-to-json")('Map');
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/es6.object.assign", ["npm:core-js@0.9.6/library/modules/$.def", "npm:core-js@0.9.6/library/modules/$.assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $def = require("npm:core-js@0.9.6/library/modules/$.def");
  $def($def.S, 'Object', {assign: require("npm:core-js@0.9.6/library/modules/$.assign")});
  global.define = __define;
  return module.exports;
});

System.register("bower:fetch@0.8.1", ["bower:fetch@0.8.1/fetch"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("bower:fetch@0.8.1/fetch");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.iter", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.cof", "npm:core-js@0.9.6/library/modules/$.assert", "npm:core-js@0.9.6/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      cof = require("npm:core-js@0.9.6/library/modules/$.cof"),
      assertObject = require("npm:core-js@0.9.6/library/modules/$.assert").obj,
      SYMBOL_ITERATOR = require("npm:core-js@0.9.6/library/modules/$.wks")('iterator'),
      FF_ITERATOR = '@@iterator',
      Iterators = {},
      IteratorPrototype = {};
  setIterator(IteratorPrototype, $.that);
  function setIterator(O, value) {
    $.hide(O, SYMBOL_ITERATOR, value);
    if (FF_ITERATOR in [])
      $.hide(O, FF_ITERATOR, value);
  }
  module.exports = {
    BUGGY: 'keys' in [] && !('next' in [].keys()),
    Iterators: Iterators,
    step: function(done, value) {
      return {
        value: value,
        done: !!done
      };
    },
    is: function(it) {
      var O = Object(it),
          Symbol = $.g.Symbol,
          SYM = Symbol && Symbol.iterator || FF_ITERATOR;
      return SYM in O || SYMBOL_ITERATOR in O || $.has(Iterators, cof.classof(O));
    },
    get: function(it) {
      var Symbol = $.g.Symbol,
          ext = it[Symbol && Symbol.iterator || FF_ITERATOR],
          getIter = ext || it[SYMBOL_ITERATOR] || Iterators[cof.classof(it)];
      return assertObject(getIter.call(it));
    },
    set: setIterator,
    create: function(Constructor, NAME, next, proto) {
      Constructor.prototype = $.create(proto || IteratorPrototype, {next: $.desc(1, next)});
      cof.set(Constructor, NAME + ' Iterator');
    }
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/web.dom.iterable", ["npm:core-js@0.9.6/library/modules/es6.array.iterator", "npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.iter", "npm:core-js@0.9.6/library/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/library/modules/es6.array.iterator");
  var $ = require("npm:core-js@0.9.6/library/modules/$"),
      Iterators = require("npm:core-js@0.9.6/library/modules/$.iter").Iterators,
      ITERATOR = require("npm:core-js@0.9.6/library/modules/$.wks")('iterator'),
      ArrayValues = Iterators.Array,
      NodeList = $.g.NodeList;
  if ($.FW && NodeList && !(ITERATOR in NodeList.prototype)) {
    $.hide(NodeList.prototype, ITERATOR, ArrayValues);
  }
  Iterators.NodeList = ArrayValues;
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-process@0.1.1/index", ["npm:process@0.10.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = System._nodeRequire ? process : require("npm:process@0.10.1");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.cof", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.wks"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      TAG = require("npm:core-js@0.9.6/modules/$.wks")('toStringTag'),
      toString = {}.toString;
  function cof(it) {
    return toString.call(it).slice(8, -1);
  }
  cof.classof = function(it) {
    var O,
        T;
    return it == undefined ? it === undefined ? 'Undefined' : 'Null' : typeof(T = (O = Object(it))[TAG]) == 'string' ? T : cof(O);
  };
  cof.set = function(it, tag, stat) {
    if (it && !$.has(it = stat ? it : it.prototype, TAG))
      $.hide(it, TAG, tag);
  };
  module.exports = cof;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/$.array-methods", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.ctx"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      ctx = require("npm:core-js@0.9.6/modules/$.ctx");
  module.exports = function(TYPE) {
    var IS_MAP = TYPE == 1,
        IS_FILTER = TYPE == 2,
        IS_SOME = TYPE == 3,
        IS_EVERY = TYPE == 4,
        IS_FIND_INDEX = TYPE == 6,
        NO_HOLES = TYPE == 5 || IS_FIND_INDEX;
    return function($this, callbackfn, that) {
      var O = Object($.assertDefined($this)),
          self = $.ES5Object(O),
          f = ctx(callbackfn, that, 3),
          length = $.toLength(self.length),
          index = 0,
          result = IS_MAP ? Array(length) : IS_FILTER ? [] : undefined,
          val,
          res;
      for (; length > index; index++)
        if (NO_HOLES || index in self) {
          val = self[index];
          res = f(val, index, O);
          if (TYPE) {
            if (IS_MAP)
              result[index] = res;
            else if (res)
              switch (TYPE) {
                case 3:
                  return true;
                case 5:
                  return val;
                case 6:
                  return index;
                case 2:
                  result.push(val);
              }
            else if (IS_EVERY)
              return false;
          }
        }
      return IS_FIND_INDEX ? -1 : IS_SOME || IS_EVERY ? IS_EVERY : result;
    };
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/fn/symbol/index", ["npm:core-js@0.9.6/library/modules/es6.symbol", "npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/library/modules/es6.symbol");
  module.exports = require("npm:core-js@0.9.6/library/modules/$").core.Symbol;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/helpers/create-class", ["npm:babel-runtime@5.2.9/core-js/object/define-property"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = require("npm:babel-runtime@5.2.9/core-js/object/define-property")["default"];
  exports["default"] = (function() {
    function defineProperties(target, props) {
      for (var i = 0; i < props.length; i++) {
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor)
          descriptor.writable = true;
        _Object$defineProperty(target, descriptor.key, descriptor);
      }
    }
    return function(Constructor, protoProps, staticProps) {
      if (protoProps)
        defineProperties(Constructor.prototype, protoProps);
      if (staticProps)
        defineProperties(Constructor, staticProps);
      return Constructor;
    };
  })();
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:buffer@3.2.2/index", ["npm:base64-js@0.0.8", "npm:ieee754@1.1.5", "npm:is-array@1.0.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var base64 = require("npm:base64-js@0.0.8");
  var ieee754 = require("npm:ieee754@1.1.5");
  var isArray = require("npm:is-array@1.0.1");
  exports.Buffer = Buffer;
  exports.SlowBuffer = SlowBuffer;
  exports.INSPECT_MAX_BYTES = 50;
  Buffer.poolSize = 8192;
  var kMaxLength = 0x3fffffff;
  var rootParent = {};
  Buffer.TYPED_ARRAY_SUPPORT = (function() {
    try {
      var buf = new ArrayBuffer(0);
      var arr = new Uint8Array(buf);
      arr.foo = function() {
        return 42;
      };
      return arr.foo() === 42 && typeof arr.subarray === 'function' && new Uint8Array(1).subarray(1, 1).byteLength === 0;
    } catch (e) {
      return false;
    }
  })();
  function Buffer(arg) {
    if (!(this instanceof Buffer)) {
      if (arguments.length > 1)
        return new Buffer(arg, arguments[1]);
      return new Buffer(arg);
    }
    this.length = 0;
    this.parent = undefined;
    if (typeof arg === 'number') {
      return fromNumber(this, arg);
    }
    if (typeof arg === 'string') {
      return fromString(this, arg, arguments.length > 1 ? arguments[1] : 'utf8');
    }
    return fromObject(this, arg);
  }
  function fromNumber(that, length) {
    that = allocate(that, length < 0 ? 0 : checked(length) | 0);
    if (!Buffer.TYPED_ARRAY_SUPPORT) {
      for (var i = 0; i < length; i++) {
        that[i] = 0;
      }
    }
    return that;
  }
  function fromString(that, string, encoding) {
    if (typeof encoding !== 'string' || encoding === '')
      encoding = 'utf8';
    var length = byteLength(string, encoding) | 0;
    that = allocate(that, length);
    that.write(string, encoding);
    return that;
  }
  function fromObject(that, object) {
    if (Buffer.isBuffer(object))
      return fromBuffer(that, object);
    if (isArray(object))
      return fromArray(that, object);
    if (object == null) {
      throw new TypeError('must start with number, buffer, array or string');
    }
    if (typeof ArrayBuffer !== 'undefined' && object.buffer instanceof ArrayBuffer) {
      return fromTypedArray(that, object);
    }
    if (object.length)
      return fromArrayLike(that, object);
    return fromJsonObject(that, object);
  }
  function fromBuffer(that, buffer) {
    var length = checked(buffer.length) | 0;
    that = allocate(that, length);
    buffer.copy(that, 0, 0, length);
    return that;
  }
  function fromArray(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromTypedArray(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromArrayLike(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromJsonObject(that, object) {
    var array;
    var length = 0;
    if (object.type === 'Buffer' && isArray(object.data)) {
      array = object.data;
      length = checked(array.length) | 0;
    }
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function allocate(that, length) {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      that = Buffer._augment(new Uint8Array(length));
    } else {
      that.length = length;
      that._isBuffer = true;
    }
    var fromPool = length !== 0 && length <= Buffer.poolSize >>> 1;
    if (fromPool)
      that.parent = rootParent;
    return that;
  }
  function checked(length) {
    if (length >= kMaxLength) {
      throw new RangeError('Attempt to allocate Buffer larger than maximum ' + 'size: 0x' + kMaxLength.toString(16) + ' bytes');
    }
    return length | 0;
  }
  function SlowBuffer(subject, encoding) {
    if (!(this instanceof SlowBuffer))
      return new SlowBuffer(subject, encoding);
    var buf = new Buffer(subject, encoding);
    delete buf.parent;
    return buf;
  }
  Buffer.isBuffer = function isBuffer(b) {
    return !!(b != null && b._isBuffer);
  };
  Buffer.compare = function compare(a, b) {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
      throw new TypeError('Arguments must be Buffers');
    }
    if (a === b)
      return 0;
    var x = a.length;
    var y = b.length;
    var i = 0;
    var len = Math.min(x, y);
    while (i < len) {
      if (a[i] !== b[i])
        break;
      ++i;
    }
    if (i !== len) {
      x = a[i];
      y = b[i];
    }
    if (x < y)
      return -1;
    if (y < x)
      return 1;
    return 0;
  };
  Buffer.isEncoding = function isEncoding(encoding) {
    switch (String(encoding).toLowerCase()) {
      case 'hex':
      case 'utf8':
      case 'utf-8':
      case 'ascii':
      case 'binary':
      case 'base64':
      case 'raw':
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return true;
      default:
        return false;
    }
  };
  Buffer.concat = function concat(list, length) {
    if (!isArray(list))
      throw new TypeError('list argument must be an Array of Buffers.');
    if (list.length === 0) {
      return new Buffer(0);
    } else if (list.length === 1) {
      return list[0];
    }
    var i;
    if (length === undefined) {
      length = 0;
      for (i = 0; i < list.length; i++) {
        length += list[i].length;
      }
    }
    var buf = new Buffer(length);
    var pos = 0;
    for (i = 0; i < list.length; i++) {
      var item = list[i];
      item.copy(buf, pos);
      pos += item.length;
    }
    return buf;
  };
  function byteLength(string, encoding) {
    if (typeof string !== 'string')
      string = String(string);
    if (string.length === 0)
      return 0;
    switch (encoding || 'utf8') {
      case 'ascii':
      case 'binary':
      case 'raw':
        return string.length;
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return string.length * 2;
      case 'hex':
        return string.length >>> 1;
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length;
      case 'base64':
        return base64ToBytes(string).length;
      default:
        return string.length;
    }
  }
  Buffer.byteLength = byteLength;
  Buffer.prototype.length = undefined;
  Buffer.prototype.parent = undefined;
  Buffer.prototype.toString = function toString(encoding, start, end) {
    var loweredCase = false;
    start = start | 0;
    end = end === undefined || end === Infinity ? this.length : end | 0;
    if (!encoding)
      encoding = 'utf8';
    if (start < 0)
      start = 0;
    if (end > this.length)
      end = this.length;
    if (end <= start)
      return '';
    while (true) {
      switch (encoding) {
        case 'hex':
          return hexSlice(this, start, end);
        case 'utf8':
        case 'utf-8':
          return utf8Slice(this, start, end);
        case 'ascii':
          return asciiSlice(this, start, end);
        case 'binary':
          return binarySlice(this, start, end);
        case 'base64':
          return base64Slice(this, start, end);
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return utf16leSlice(this, start, end);
        default:
          if (loweredCase)
            throw new TypeError('Unknown encoding: ' + encoding);
          encoding = (encoding + '').toLowerCase();
          loweredCase = true;
      }
    }
  };
  Buffer.prototype.equals = function equals(b) {
    if (!Buffer.isBuffer(b))
      throw new TypeError('Argument must be a Buffer');
    if (this === b)
      return true;
    return Buffer.compare(this, b) === 0;
  };
  Buffer.prototype.inspect = function inspect() {
    var str = '';
    var max = exports.INSPECT_MAX_BYTES;
    if (this.length > 0) {
      str = this.toString('hex', 0, max).match(/.{2}/g).join(' ');
      if (this.length > max)
        str += ' ... ';
    }
    return '<Buffer ' + str + '>';
  };
  Buffer.prototype.compare = function compare(b) {
    if (!Buffer.isBuffer(b))
      throw new TypeError('Argument must be a Buffer');
    if (this === b)
      return 0;
    return Buffer.compare(this, b);
  };
  Buffer.prototype.indexOf = function indexOf(val, byteOffset) {
    if (byteOffset > 0x7fffffff)
      byteOffset = 0x7fffffff;
    else if (byteOffset < -0x80000000)
      byteOffset = -0x80000000;
    byteOffset >>= 0;
    if (this.length === 0)
      return -1;
    if (byteOffset >= this.length)
      return -1;
    if (byteOffset < 0)
      byteOffset = Math.max(this.length + byteOffset, 0);
    if (typeof val === 'string') {
      if (val.length === 0)
        return -1;
      return String.prototype.indexOf.call(this, val, byteOffset);
    }
    if (Buffer.isBuffer(val)) {
      return arrayIndexOf(this, val, byteOffset);
    }
    if (typeof val === 'number') {
      if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
        return Uint8Array.prototype.indexOf.call(this, val, byteOffset);
      }
      return arrayIndexOf(this, [val], byteOffset);
    }
    function arrayIndexOf(arr, val, byteOffset) {
      var foundIndex = -1;
      for (var i = 0; byteOffset + i < arr.length; i++) {
        if (arr[byteOffset + i] === val[foundIndex === -1 ? 0 : i - foundIndex]) {
          if (foundIndex === -1)
            foundIndex = i;
          if (i - foundIndex + 1 === val.length)
            return byteOffset + foundIndex;
        } else {
          foundIndex = -1;
        }
      }
      return -1;
    }
    throw new TypeError('val must be string, number or Buffer');
  };
  Buffer.prototype.get = function get(offset) {
    console.log('.get() is deprecated. Access using array indexes instead.');
    return this.readUInt8(offset);
  };
  Buffer.prototype.set = function set(v, offset) {
    console.log('.set() is deprecated. Access using array indexes instead.');
    return this.writeUInt8(v, offset);
  };
  function hexWrite(buf, string, offset, length) {
    offset = Number(offset) || 0;
    var remaining = buf.length - offset;
    if (!length) {
      length = remaining;
    } else {
      length = Number(length);
      if (length > remaining) {
        length = remaining;
      }
    }
    var strLen = string.length;
    if (strLen % 2 !== 0)
      throw new Error('Invalid hex string');
    if (length > strLen / 2) {
      length = strLen / 2;
    }
    for (var i = 0; i < length; i++) {
      var parsed = parseInt(string.substr(i * 2, 2), 16);
      if (isNaN(parsed))
        throw new Error('Invalid hex string');
      buf[offset + i] = parsed;
    }
    return i;
  }
  function utf8Write(buf, string, offset, length) {
    return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
  }
  function asciiWrite(buf, string, offset, length) {
    return blitBuffer(asciiToBytes(string), buf, offset, length);
  }
  function binaryWrite(buf, string, offset, length) {
    return asciiWrite(buf, string, offset, length);
  }
  function base64Write(buf, string, offset, length) {
    return blitBuffer(base64ToBytes(string), buf, offset, length);
  }
  function ucs2Write(buf, string, offset, length) {
    return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
  }
  Buffer.prototype.write = function write(string, offset, length, encoding) {
    if (offset === undefined) {
      encoding = 'utf8';
      length = this.length;
      offset = 0;
    } else if (length === undefined && typeof offset === 'string') {
      encoding = offset;
      length = this.length;
      offset = 0;
    } else if (isFinite(offset)) {
      offset = offset | 0;
      if (isFinite(length)) {
        length = length | 0;
        if (encoding === undefined)
          encoding = 'utf8';
      } else {
        encoding = length;
        length = undefined;
      }
    } else {
      var swap = encoding;
      encoding = offset;
      offset = length | 0;
      length = swap;
    }
    var remaining = this.length - offset;
    if (length === undefined || length > remaining)
      length = remaining;
    if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
      throw new RangeError('attempt to write outside buffer bounds');
    }
    if (!encoding)
      encoding = 'utf8';
    var loweredCase = false;
    for (; ; ) {
      switch (encoding) {
        case 'hex':
          return hexWrite(this, string, offset, length);
        case 'utf8':
        case 'utf-8':
          return utf8Write(this, string, offset, length);
        case 'ascii':
          return asciiWrite(this, string, offset, length);
        case 'binary':
          return binaryWrite(this, string, offset, length);
        case 'base64':
          return base64Write(this, string, offset, length);
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return ucs2Write(this, string, offset, length);
        default:
          if (loweredCase)
            throw new TypeError('Unknown encoding: ' + encoding);
          encoding = ('' + encoding).toLowerCase();
          loweredCase = true;
      }
    }
  };
  Buffer.prototype.toJSON = function toJSON() {
    return {
      type: 'Buffer',
      data: Array.prototype.slice.call(this._arr || this, 0)
    };
  };
  function base64Slice(buf, start, end) {
    if (start === 0 && end === buf.length) {
      return base64.fromByteArray(buf);
    } else {
      return base64.fromByteArray(buf.slice(start, end));
    }
  }
  function utf8Slice(buf, start, end) {
    var res = '';
    var tmp = '';
    end = Math.min(buf.length, end);
    for (var i = start; i < end; i++) {
      if (buf[i] <= 0x7F) {
        res += decodeUtf8Char(tmp) + String.fromCharCode(buf[i]);
        tmp = '';
      } else {
        tmp += '%' + buf[i].toString(16);
      }
    }
    return res + decodeUtf8Char(tmp);
  }
  function asciiSlice(buf, start, end) {
    var ret = '';
    end = Math.min(buf.length, end);
    for (var i = start; i < end; i++) {
      ret += String.fromCharCode(buf[i] & 0x7F);
    }
    return ret;
  }
  function binarySlice(buf, start, end) {
    var ret = '';
    end = Math.min(buf.length, end);
    for (var i = start; i < end; i++) {
      ret += String.fromCharCode(buf[i]);
    }
    return ret;
  }
  function hexSlice(buf, start, end) {
    var len = buf.length;
    if (!start || start < 0)
      start = 0;
    if (!end || end < 0 || end > len)
      end = len;
    var out = '';
    for (var i = start; i < end; i++) {
      out += toHex(buf[i]);
    }
    return out;
  }
  function utf16leSlice(buf, start, end) {
    var bytes = buf.slice(start, end);
    var res = '';
    for (var i = 0; i < bytes.length; i += 2) {
      res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256);
    }
    return res;
  }
  Buffer.prototype.slice = function slice(start, end) {
    var len = this.length;
    start = ~~start;
    end = end === undefined ? len : ~~end;
    if (start < 0) {
      start += len;
      if (start < 0)
        start = 0;
    } else if (start > len) {
      start = len;
    }
    if (end < 0) {
      end += len;
      if (end < 0)
        end = 0;
    } else if (end > len) {
      end = len;
    }
    if (end < start)
      end = start;
    var newBuf;
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      newBuf = Buffer._augment(this.subarray(start, end));
    } else {
      var sliceLen = end - start;
      newBuf = new Buffer(sliceLen, undefined);
      for (var i = 0; i < sliceLen; i++) {
        newBuf[i] = this[i + start];
      }
    }
    if (newBuf.length)
      newBuf.parent = this.parent || this;
    return newBuf;
  };
  function checkOffset(offset, ext, length) {
    if ((offset % 1) !== 0 || offset < 0)
      throw new RangeError('offset is not uint');
    if (offset + ext > length)
      throw new RangeError('Trying to access beyond buffer length');
  }
  Buffer.prototype.readUIntLE = function readUIntLE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var val = this[offset];
    var mul = 1;
    var i = 0;
    while (++i < byteLength && (mul *= 0x100)) {
      val += this[offset + i] * mul;
    }
    return val;
  };
  Buffer.prototype.readUIntBE = function readUIntBE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert) {
      checkOffset(offset, byteLength, this.length);
    }
    var val = this[offset + --byteLength];
    var mul = 1;
    while (byteLength > 0 && (mul *= 0x100)) {
      val += this[offset + --byteLength] * mul;
    }
    return val;
  };
  Buffer.prototype.readUInt8 = function readUInt8(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 1, this.length);
    return this[offset];
  };
  Buffer.prototype.readUInt16LE = function readUInt16LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    return this[offset] | (this[offset + 1] << 8);
  };
  Buffer.prototype.readUInt16BE = function readUInt16BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    return (this[offset] << 8) | this[offset + 1];
  };
  Buffer.prototype.readUInt32LE = function readUInt32LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ((this[offset]) | (this[offset + 1] << 8) | (this[offset + 2] << 16)) + (this[offset + 3] * 0x1000000);
  };
  Buffer.prototype.readUInt32BE = function readUInt32BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset] * 0x1000000) + ((this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]);
  };
  Buffer.prototype.readIntLE = function readIntLE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var val = this[offset];
    var mul = 1;
    var i = 0;
    while (++i < byteLength && (mul *= 0x100)) {
      val += this[offset + i] * mul;
    }
    mul *= 0x80;
    if (val >= mul)
      val -= Math.pow(2, 8 * byteLength);
    return val;
  };
  Buffer.prototype.readIntBE = function readIntBE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var i = byteLength;
    var mul = 1;
    var val = this[offset + --i];
    while (i > 0 && (mul *= 0x100)) {
      val += this[offset + --i] * mul;
    }
    mul *= 0x80;
    if (val >= mul)
      val -= Math.pow(2, 8 * byteLength);
    return val;
  };
  Buffer.prototype.readInt8 = function readInt8(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 1, this.length);
    if (!(this[offset] & 0x80))
      return (this[offset]);
    return ((0xff - this[offset] + 1) * -1);
  };
  Buffer.prototype.readInt16LE = function readInt16LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    var val = this[offset] | (this[offset + 1] << 8);
    return (val & 0x8000) ? val | 0xFFFF0000 : val;
  };
  Buffer.prototype.readInt16BE = function readInt16BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    var val = this[offset + 1] | (this[offset] << 8);
    return (val & 0x8000) ? val | 0xFFFF0000 : val;
  };
  Buffer.prototype.readInt32LE = function readInt32LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset]) | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24);
  };
  Buffer.prototype.readInt32BE = function readInt32BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | (this[offset + 3]);
  };
  Buffer.prototype.readFloatLE = function readFloatLE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ieee754.read(this, offset, true, 23, 4);
  };
  Buffer.prototype.readFloatBE = function readFloatBE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ieee754.read(this, offset, false, 23, 4);
  };
  Buffer.prototype.readDoubleLE = function readDoubleLE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 8, this.length);
    return ieee754.read(this, offset, true, 52, 8);
  };
  Buffer.prototype.readDoubleBE = function readDoubleBE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 8, this.length);
    return ieee754.read(this, offset, false, 52, 8);
  };
  function checkInt(buf, value, offset, ext, max, min) {
    if (!Buffer.isBuffer(buf))
      throw new TypeError('buffer must be a Buffer instance');
    if (value > max || value < min)
      throw new RangeError('value is out of bounds');
    if (offset + ext > buf.length)
      throw new RangeError('index out of range');
  }
  Buffer.prototype.writeUIntLE = function writeUIntLE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0);
    var mul = 1;
    var i = 0;
    this[offset] = value & 0xFF;
    while (++i < byteLength && (mul *= 0x100)) {
      this[offset + i] = (value / mul) & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeUIntBE = function writeUIntBE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0);
    var i = byteLength - 1;
    var mul = 1;
    this[offset + i] = value & 0xFF;
    while (--i >= 0 && (mul *= 0x100)) {
      this[offset + i] = (value / mul) & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeUInt8 = function writeUInt8(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 1, 0xff, 0);
    if (!Buffer.TYPED_ARRAY_SUPPORT)
      value = Math.floor(value);
    this[offset] = value;
    return offset + 1;
  };
  function objectWriteUInt16(buf, value, offset, littleEndian) {
    if (value < 0)
      value = 0xffff + value + 1;
    for (var i = 0,
        j = Math.min(buf.length - offset, 2); i < j; i++) {
      buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>> (littleEndian ? i : 1 - i) * 8;
    }
  }
  Buffer.prototype.writeUInt16LE = function writeUInt16LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0xffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = value;
      this[offset + 1] = (value >>> 8);
    } else {
      objectWriteUInt16(this, value, offset, true);
    }
    return offset + 2;
  };
  Buffer.prototype.writeUInt16BE = function writeUInt16BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0xffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 8);
      this[offset + 1] = value;
    } else {
      objectWriteUInt16(this, value, offset, false);
    }
    return offset + 2;
  };
  function objectWriteUInt32(buf, value, offset, littleEndian) {
    if (value < 0)
      value = 0xffffffff + value + 1;
    for (var i = 0,
        j = Math.min(buf.length - offset, 4); i < j; i++) {
      buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff;
    }
  }
  Buffer.prototype.writeUInt32LE = function writeUInt32LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0xffffffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset + 3] = (value >>> 24);
      this[offset + 2] = (value >>> 16);
      this[offset + 1] = (value >>> 8);
      this[offset] = value;
    } else {
      objectWriteUInt32(this, value, offset, true);
    }
    return offset + 4;
  };
  Buffer.prototype.writeUInt32BE = function writeUInt32BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0xffffffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 24);
      this[offset + 1] = (value >>> 16);
      this[offset + 2] = (value >>> 8);
      this[offset + 3] = value;
    } else {
      objectWriteUInt32(this, value, offset, false);
    }
    return offset + 4;
  };
  Buffer.prototype.writeIntLE = function writeIntLE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert) {
      var limit = Math.pow(2, 8 * byteLength - 1);
      checkInt(this, value, offset, byteLength, limit - 1, -limit);
    }
    var i = 0;
    var mul = 1;
    var sub = value < 0 ? 1 : 0;
    this[offset] = value & 0xFF;
    while (++i < byteLength && (mul *= 0x100)) {
      this[offset + i] = ((value / mul) >> 0) - sub & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeIntBE = function writeIntBE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert) {
      var limit = Math.pow(2, 8 * byteLength - 1);
      checkInt(this, value, offset, byteLength, limit - 1, -limit);
    }
    var i = byteLength - 1;
    var mul = 1;
    var sub = value < 0 ? 1 : 0;
    this[offset + i] = value & 0xFF;
    while (--i >= 0 && (mul *= 0x100)) {
      this[offset + i] = ((value / mul) >> 0) - sub & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeInt8 = function writeInt8(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 1, 0x7f, -0x80);
    if (!Buffer.TYPED_ARRAY_SUPPORT)
      value = Math.floor(value);
    if (value < 0)
      value = 0xff + value + 1;
    this[offset] = value;
    return offset + 1;
  };
  Buffer.prototype.writeInt16LE = function writeInt16LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0x7fff, -0x8000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = value;
      this[offset + 1] = (value >>> 8);
    } else {
      objectWriteUInt16(this, value, offset, true);
    }
    return offset + 2;
  };
  Buffer.prototype.writeInt16BE = function writeInt16BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0x7fff, -0x8000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 8);
      this[offset + 1] = value;
    } else {
      objectWriteUInt16(this, value, offset, false);
    }
    return offset + 2;
  };
  Buffer.prototype.writeInt32LE = function writeInt32LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = value;
      this[offset + 1] = (value >>> 8);
      this[offset + 2] = (value >>> 16);
      this[offset + 3] = (value >>> 24);
    } else {
      objectWriteUInt32(this, value, offset, true);
    }
    return offset + 4;
  };
  Buffer.prototype.writeInt32BE = function writeInt32BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
    if (value < 0)
      value = 0xffffffff + value + 1;
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 24);
      this[offset + 1] = (value >>> 16);
      this[offset + 2] = (value >>> 8);
      this[offset + 3] = value;
    } else {
      objectWriteUInt32(this, value, offset, false);
    }
    return offset + 4;
  };
  function checkIEEE754(buf, value, offset, ext, max, min) {
    if (value > max || value < min)
      throw new RangeError('value is out of bounds');
    if (offset + ext > buf.length)
      throw new RangeError('index out of range');
    if (offset < 0)
      throw new RangeError('index out of range');
  }
  function writeFloat(buf, value, offset, littleEndian, noAssert) {
    if (!noAssert) {
      checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38);
    }
    ieee754.write(buf, value, offset, littleEndian, 23, 4);
    return offset + 4;
  }
  Buffer.prototype.writeFloatLE = function writeFloatLE(value, offset, noAssert) {
    return writeFloat(this, value, offset, true, noAssert);
  };
  Buffer.prototype.writeFloatBE = function writeFloatBE(value, offset, noAssert) {
    return writeFloat(this, value, offset, false, noAssert);
  };
  function writeDouble(buf, value, offset, littleEndian, noAssert) {
    if (!noAssert) {
      checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308);
    }
    ieee754.write(buf, value, offset, littleEndian, 52, 8);
    return offset + 8;
  }
  Buffer.prototype.writeDoubleLE = function writeDoubleLE(value, offset, noAssert) {
    return writeDouble(this, value, offset, true, noAssert);
  };
  Buffer.prototype.writeDoubleBE = function writeDoubleBE(value, offset, noAssert) {
    return writeDouble(this, value, offset, false, noAssert);
  };
  Buffer.prototype.copy = function copy(target, targetStart, start, end) {
    if (!start)
      start = 0;
    if (!end && end !== 0)
      end = this.length;
    if (targetStart >= target.length)
      targetStart = target.length;
    if (!targetStart)
      targetStart = 0;
    if (end > 0 && end < start)
      end = start;
    if (end === start)
      return 0;
    if (target.length === 0 || this.length === 0)
      return 0;
    if (targetStart < 0) {
      throw new RangeError('targetStart out of bounds');
    }
    if (start < 0 || start >= this.length)
      throw new RangeError('sourceStart out of bounds');
    if (end < 0)
      throw new RangeError('sourceEnd out of bounds');
    if (end > this.length)
      end = this.length;
    if (target.length - targetStart < end - start) {
      end = target.length - targetStart + start;
    }
    var len = end - start;
    if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
      for (var i = 0; i < len; i++) {
        target[i + targetStart] = this[i + start];
      }
    } else {
      target._set(this.subarray(start, start + len), targetStart);
    }
    return len;
  };
  Buffer.prototype.fill = function fill(value, start, end) {
    if (!value)
      value = 0;
    if (!start)
      start = 0;
    if (!end)
      end = this.length;
    if (end < start)
      throw new RangeError('end < start');
    if (end === start)
      return ;
    if (this.length === 0)
      return ;
    if (start < 0 || start >= this.length)
      throw new RangeError('start out of bounds');
    if (end < 0 || end > this.length)
      throw new RangeError('end out of bounds');
    var i;
    if (typeof value === 'number') {
      for (i = start; i < end; i++) {
        this[i] = value;
      }
    } else {
      var bytes = utf8ToBytes(value.toString());
      var len = bytes.length;
      for (i = start; i < end; i++) {
        this[i] = bytes[i % len];
      }
    }
    return this;
  };
  Buffer.prototype.toArrayBuffer = function toArrayBuffer() {
    if (typeof Uint8Array !== 'undefined') {
      if (Buffer.TYPED_ARRAY_SUPPORT) {
        return (new Buffer(this)).buffer;
      } else {
        var buf = new Uint8Array(this.length);
        for (var i = 0,
            len = buf.length; i < len; i += 1) {
          buf[i] = this[i];
        }
        return buf.buffer;
      }
    } else {
      throw new TypeError('Buffer.toArrayBuffer not supported in this browser');
    }
  };
  var BP = Buffer.prototype;
  Buffer._augment = function _augment(arr) {
    arr.constructor = Buffer;
    arr._isBuffer = true;
    arr._set = arr.set;
    arr.get = BP.get;
    arr.set = BP.set;
    arr.write = BP.write;
    arr.toString = BP.toString;
    arr.toLocaleString = BP.toString;
    arr.toJSON = BP.toJSON;
    arr.equals = BP.equals;
    arr.compare = BP.compare;
    arr.indexOf = BP.indexOf;
    arr.copy = BP.copy;
    arr.slice = BP.slice;
    arr.readUIntLE = BP.readUIntLE;
    arr.readUIntBE = BP.readUIntBE;
    arr.readUInt8 = BP.readUInt8;
    arr.readUInt16LE = BP.readUInt16LE;
    arr.readUInt16BE = BP.readUInt16BE;
    arr.readUInt32LE = BP.readUInt32LE;
    arr.readUInt32BE = BP.readUInt32BE;
    arr.readIntLE = BP.readIntLE;
    arr.readIntBE = BP.readIntBE;
    arr.readInt8 = BP.readInt8;
    arr.readInt16LE = BP.readInt16LE;
    arr.readInt16BE = BP.readInt16BE;
    arr.readInt32LE = BP.readInt32LE;
    arr.readInt32BE = BP.readInt32BE;
    arr.readFloatLE = BP.readFloatLE;
    arr.readFloatBE = BP.readFloatBE;
    arr.readDoubleLE = BP.readDoubleLE;
    arr.readDoubleBE = BP.readDoubleBE;
    arr.writeUInt8 = BP.writeUInt8;
    arr.writeUIntLE = BP.writeUIntLE;
    arr.writeUIntBE = BP.writeUIntBE;
    arr.writeUInt16LE = BP.writeUInt16LE;
    arr.writeUInt16BE = BP.writeUInt16BE;
    arr.writeUInt32LE = BP.writeUInt32LE;
    arr.writeUInt32BE = BP.writeUInt32BE;
    arr.writeIntLE = BP.writeIntLE;
    arr.writeIntBE = BP.writeIntBE;
    arr.writeInt8 = BP.writeInt8;
    arr.writeInt16LE = BP.writeInt16LE;
    arr.writeInt16BE = BP.writeInt16BE;
    arr.writeInt32LE = BP.writeInt32LE;
    arr.writeInt32BE = BP.writeInt32BE;
    arr.writeFloatLE = BP.writeFloatLE;
    arr.writeFloatBE = BP.writeFloatBE;
    arr.writeDoubleLE = BP.writeDoubleLE;
    arr.writeDoubleBE = BP.writeDoubleBE;
    arr.fill = BP.fill;
    arr.inspect = BP.inspect;
    arr.toArrayBuffer = BP.toArrayBuffer;
    return arr;
  };
  var INVALID_BASE64_RE = /[^+\/0-9A-z\-]/g;
  function base64clean(str) {
    str = stringtrim(str).replace(INVALID_BASE64_RE, '');
    if (str.length < 2)
      return '';
    while (str.length % 4 !== 0) {
      str = str + '=';
    }
    return str;
  }
  function stringtrim(str) {
    if (str.trim)
      return str.trim();
    return str.replace(/^\s+|\s+$/g, '');
  }
  function toHex(n) {
    if (n < 16)
      return '0' + n.toString(16);
    return n.toString(16);
  }
  function utf8ToBytes(string, units) {
    units = units || Infinity;
    var codePoint;
    var length = string.length;
    var leadSurrogate = null;
    var bytes = [];
    var i = 0;
    for (; i < length; i++) {
      codePoint = string.charCodeAt(i);
      if (codePoint > 0xD7FF && codePoint < 0xE000) {
        if (leadSurrogate) {
          if (codePoint < 0xDC00) {
            if ((units -= 3) > -1)
              bytes.push(0xEF, 0xBF, 0xBD);
            leadSurrogate = codePoint;
            continue;
          } else {
            codePoint = leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00 | 0x10000;
            leadSurrogate = null;
          }
        } else {
          if (codePoint > 0xDBFF) {
            if ((units -= 3) > -1)
              bytes.push(0xEF, 0xBF, 0xBD);
            continue;
          } else if (i + 1 === length) {
            if ((units -= 3) > -1)
              bytes.push(0xEF, 0xBF, 0xBD);
            continue;
          } else {
            leadSurrogate = codePoint;
            continue;
          }
        }
      } else if (leadSurrogate) {
        if ((units -= 3) > -1)
          bytes.push(0xEF, 0xBF, 0xBD);
        leadSurrogate = null;
      }
      if (codePoint < 0x80) {
        if ((units -= 1) < 0)
          break;
        bytes.push(codePoint);
      } else if (codePoint < 0x800) {
        if ((units -= 2) < 0)
          break;
        bytes.push(codePoint >> 0x6 | 0xC0, codePoint & 0x3F | 0x80);
      } else if (codePoint < 0x10000) {
        if ((units -= 3) < 0)
          break;
        bytes.push(codePoint >> 0xC | 0xE0, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
      } else if (codePoint < 0x200000) {
        if ((units -= 4) < 0)
          break;
        bytes.push(codePoint >> 0x12 | 0xF0, codePoint >> 0xC & 0x3F | 0x80, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
      } else {
        throw new Error('Invalid code point');
      }
    }
    return bytes;
  }
  function asciiToBytes(str) {
    var byteArray = [];
    for (var i = 0; i < str.length; i++) {
      byteArray.push(str.charCodeAt(i) & 0xFF);
    }
    return byteArray;
  }
  function utf16leToBytes(str, units) {
    var c,
        hi,
        lo;
    var byteArray = [];
    for (var i = 0; i < str.length; i++) {
      if ((units -= 2) < 0)
        break;
      c = str.charCodeAt(i);
      hi = c >> 8;
      lo = c % 256;
      byteArray.push(lo);
      byteArray.push(hi);
    }
    return byteArray;
  }
  function base64ToBytes(str) {
    return base64.toByteArray(base64clean(str));
  }
  function blitBuffer(src, dst, offset, length) {
    for (var i = 0; i < length; i++) {
      if ((i + offset >= dst.length) || (i >= src.length))
        break;
      dst[i + offset] = src[i];
    }
    return i;
  }
  function decodeUtf8Char(str) {
    try {
      return decodeURIComponent(str);
    } catch (err) {
      return String.fromCharCode(0xFFFD);
    }
  }
  global.define = __define;
  return module.exports;
});

System.register("npm:sha.js@2.4.0/index", ["npm:sha.js@2.4.0/sha", "npm:sha.js@2.4.0/sha1", "npm:sha.js@2.4.0/sha224", "npm:sha.js@2.4.0/sha256", "npm:sha.js@2.4.0/sha384", "npm:sha.js@2.4.0/sha512"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var exports = module.exports = function(alg) {
    var Alg = exports[alg.toLowerCase()];
    if (!Alg)
      throw new Error(alg + ' is not supported (we accept pull requests)');
    return new Alg();
  };
  exports.sha = require("npm:sha.js@2.4.0/sha");
  exports.sha1 = require("npm:sha.js@2.4.0/sha1");
  exports.sha224 = require("npm:sha.js@2.4.0/sha224");
  exports.sha256 = require("npm:sha.js@2.4.0/sha256");
  exports.sha384 = require("npm:sha.js@2.4.0/sha384");
  exports.sha512 = require("npm:sha.js@2.4.0/sha512");
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-events@0.1.0/index", ["npm:events-browserify@0.0.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = System._nodeRequire ? System._nodeRequire('events') : require("npm:events-browserify@0.0.1");
  global.define = __define;
  return module.exports;
});

System.register("npm:readable-stream@1.1.13/lib/_stream_readable", ["npm:isarray@0.0.1", "github:jspm/nodelibs-buffer@0.1.0", "github:jspm/nodelibs-events@0.1.0", "npm:stream-browserify@1.0.0/index", "npm:core-util-is@1.0.1", "npm:inherits@2.0.1", "@empty", "npm:readable-stream@1.1.13/lib/_stream_duplex", "npm:string_decoder@0.10.31", "npm:readable-stream@1.1.13/lib/_stream_duplex", "npm:string_decoder@0.10.31", "github:jspm/nodelibs-buffer@0.1.0", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer, process) {
    module.exports = Readable;
    var isArray = require("npm:isarray@0.0.1");
    var Buffer = require("github:jspm/nodelibs-buffer@0.1.0").Buffer;
    Readable.ReadableState = ReadableState;
    var EE = require("github:jspm/nodelibs-events@0.1.0").EventEmitter;
    if (!EE.listenerCount)
      EE.listenerCount = function(emitter, type) {
        return emitter.listeners(type).length;
      };
    var Stream = require("npm:stream-browserify@1.0.0/index");
    var util = require("npm:core-util-is@1.0.1");
    util.inherits = require("npm:inherits@2.0.1");
    var StringDecoder;
    var debug = require("@empty");
    if (debug && debug.debuglog) {
      debug = debug.debuglog('stream');
    } else {
      debug = function() {};
    }
    util.inherits(Readable, Stream);
    function ReadableState(options, stream) {
      var Duplex = require("npm:readable-stream@1.1.13/lib/_stream_duplex");
      options = options || {};
      var hwm = options.highWaterMark;
      var defaultHwm = options.objectMode ? 16 : 16 * 1024;
      this.highWaterMark = (hwm || hwm === 0) ? hwm : defaultHwm;
      this.highWaterMark = ~~this.highWaterMark;
      this.buffer = [];
      this.length = 0;
      this.pipes = null;
      this.pipesCount = 0;
      this.flowing = null;
      this.ended = false;
      this.endEmitted = false;
      this.reading = false;
      this.sync = true;
      this.needReadable = false;
      this.emittedReadable = false;
      this.readableListening = false;
      this.objectMode = !!options.objectMode;
      if (stream instanceof Duplex)
        this.objectMode = this.objectMode || !!options.readableObjectMode;
      this.defaultEncoding = options.defaultEncoding || 'utf8';
      this.ranOut = false;
      this.awaitDrain = 0;
      this.readingMore = false;
      this.decoder = null;
      this.encoding = null;
      if (options.encoding) {
        if (!StringDecoder)
          StringDecoder = require("npm:string_decoder@0.10.31").StringDecoder;
        this.decoder = new StringDecoder(options.encoding);
        this.encoding = options.encoding;
      }
    }
    function Readable(options) {
      var Duplex = require("npm:readable-stream@1.1.13/lib/_stream_duplex");
      if (!(this instanceof Readable))
        return new Readable(options);
      this._readableState = new ReadableState(options, this);
      this.readable = true;
      Stream.call(this);
    }
    Readable.prototype.push = function(chunk, encoding) {
      var state = this._readableState;
      if (util.isString(chunk) && !state.objectMode) {
        encoding = encoding || state.defaultEncoding;
        if (encoding !== state.encoding) {
          chunk = new Buffer(chunk, encoding);
          encoding = '';
        }
      }
      return readableAddChunk(this, state, chunk, encoding, false);
    };
    Readable.prototype.unshift = function(chunk) {
      var state = this._readableState;
      return readableAddChunk(this, state, chunk, '', true);
    };
    function readableAddChunk(stream, state, chunk, encoding, addToFront) {
      var er = chunkInvalid(state, chunk);
      if (er) {
        stream.emit('error', er);
      } else if (util.isNullOrUndefined(chunk)) {
        state.reading = false;
        if (!state.ended)
          onEofChunk(stream, state);
      } else if (state.objectMode || chunk && chunk.length > 0) {
        if (state.ended && !addToFront) {
          var e = new Error('stream.push() after EOF');
          stream.emit('error', e);
        } else if (state.endEmitted && addToFront) {
          var e = new Error('stream.unshift() after end event');
          stream.emit('error', e);
        } else {
          if (state.decoder && !addToFront && !encoding)
            chunk = state.decoder.write(chunk);
          if (!addToFront)
            state.reading = false;
          if (state.flowing && state.length === 0 && !state.sync) {
            stream.emit('data', chunk);
            stream.read(0);
          } else {
            state.length += state.objectMode ? 1 : chunk.length;
            if (addToFront)
              state.buffer.unshift(chunk);
            else
              state.buffer.push(chunk);
            if (state.needReadable)
              emitReadable(stream);
          }
          maybeReadMore(stream, state);
        }
      } else if (!addToFront) {
        state.reading = false;
      }
      return needMoreData(state);
    }
    function needMoreData(state) {
      return !state.ended && (state.needReadable || state.length < state.highWaterMark || state.length === 0);
    }
    Readable.prototype.setEncoding = function(enc) {
      if (!StringDecoder)
        StringDecoder = require("npm:string_decoder@0.10.31").StringDecoder;
      this._readableState.decoder = new StringDecoder(enc);
      this._readableState.encoding = enc;
      return this;
    };
    var MAX_HWM = 0x800000;
    function roundUpToNextPowerOf2(n) {
      if (n >= MAX_HWM) {
        n = MAX_HWM;
      } else {
        n--;
        for (var p = 1; p < 32; p <<= 1)
          n |= n >> p;
        n++;
      }
      return n;
    }
    function howMuchToRead(n, state) {
      if (state.length === 0 && state.ended)
        return 0;
      if (state.objectMode)
        return n === 0 ? 0 : 1;
      if (isNaN(n) || util.isNull(n)) {
        if (state.flowing && state.buffer.length)
          return state.buffer[0].length;
        else
          return state.length;
      }
      if (n <= 0)
        return 0;
      if (n > state.highWaterMark)
        state.highWaterMark = roundUpToNextPowerOf2(n);
      if (n > state.length) {
        if (!state.ended) {
          state.needReadable = true;
          return 0;
        } else
          return state.length;
      }
      return n;
    }
    Readable.prototype.read = function(n) {
      debug('read', n);
      var state = this._readableState;
      var nOrig = n;
      if (!util.isNumber(n) || n > 0)
        state.emittedReadable = false;
      if (n === 0 && state.needReadable && (state.length >= state.highWaterMark || state.ended)) {
        debug('read: emitReadable', state.length, state.ended);
        if (state.length === 0 && state.ended)
          endReadable(this);
        else
          emitReadable(this);
        return null;
      }
      n = howMuchToRead(n, state);
      if (n === 0 && state.ended) {
        if (state.length === 0)
          endReadable(this);
        return null;
      }
      var doRead = state.needReadable;
      debug('need readable', doRead);
      if (state.length === 0 || state.length - n < state.highWaterMark) {
        doRead = true;
        debug('length less than watermark', doRead);
      }
      if (state.ended || state.reading) {
        doRead = false;
        debug('reading or ended', doRead);
      }
      if (doRead) {
        debug('do read');
        state.reading = true;
        state.sync = true;
        if (state.length === 0)
          state.needReadable = true;
        this._read(state.highWaterMark);
        state.sync = false;
      }
      if (doRead && !state.reading)
        n = howMuchToRead(nOrig, state);
      var ret;
      if (n > 0)
        ret = fromList(n, state);
      else
        ret = null;
      if (util.isNull(ret)) {
        state.needReadable = true;
        n = 0;
      }
      state.length -= n;
      if (state.length === 0 && !state.ended)
        state.needReadable = true;
      if (nOrig !== n && state.ended && state.length === 0)
        endReadable(this);
      if (!util.isNull(ret))
        this.emit('data', ret);
      return ret;
    };
    function chunkInvalid(state, chunk) {
      var er = null;
      if (!util.isBuffer(chunk) && !util.isString(chunk) && !util.isNullOrUndefined(chunk) && !state.objectMode) {
        er = new TypeError('Invalid non-string/buffer chunk');
      }
      return er;
    }
    function onEofChunk(stream, state) {
      if (state.decoder && !state.ended) {
        var chunk = state.decoder.end();
        if (chunk && chunk.length) {
          state.buffer.push(chunk);
          state.length += state.objectMode ? 1 : chunk.length;
        }
      }
      state.ended = true;
      emitReadable(stream);
    }
    function emitReadable(stream) {
      var state = stream._readableState;
      state.needReadable = false;
      if (!state.emittedReadable) {
        debug('emitReadable', state.flowing);
        state.emittedReadable = true;
        if (state.sync)
          process.nextTick(function() {
            emitReadable_(stream);
          });
        else
          emitReadable_(stream);
      }
    }
    function emitReadable_(stream) {
      debug('emit readable');
      stream.emit('readable');
      flow(stream);
    }
    function maybeReadMore(stream, state) {
      if (!state.readingMore) {
        state.readingMore = true;
        process.nextTick(function() {
          maybeReadMore_(stream, state);
        });
      }
    }
    function maybeReadMore_(stream, state) {
      var len = state.length;
      while (!state.reading && !state.flowing && !state.ended && state.length < state.highWaterMark) {
        debug('maybeReadMore read 0');
        stream.read(0);
        if (len === state.length)
          break;
        else
          len = state.length;
      }
      state.readingMore = false;
    }
    Readable.prototype._read = function(n) {
      this.emit('error', new Error('not implemented'));
    };
    Readable.prototype.pipe = function(dest, pipeOpts) {
      var src = this;
      var state = this._readableState;
      switch (state.pipesCount) {
        case 0:
          state.pipes = dest;
          break;
        case 1:
          state.pipes = [state.pipes, dest];
          break;
        default:
          state.pipes.push(dest);
          break;
      }
      state.pipesCount += 1;
      debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);
      var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;
      var endFn = doEnd ? onend : cleanup;
      if (state.endEmitted)
        process.nextTick(endFn);
      else
        src.once('end', endFn);
      dest.on('unpipe', onunpipe);
      function onunpipe(readable) {
        debug('onunpipe');
        if (readable === src) {
          cleanup();
        }
      }
      function onend() {
        debug('onend');
        dest.end();
      }
      var ondrain = pipeOnDrain(src);
      dest.on('drain', ondrain);
      function cleanup() {
        debug('cleanup');
        dest.removeListener('close', onclose);
        dest.removeListener('finish', onfinish);
        dest.removeListener('drain', ondrain);
        dest.removeListener('error', onerror);
        dest.removeListener('unpipe', onunpipe);
        src.removeListener('end', onend);
        src.removeListener('end', cleanup);
        src.removeListener('data', ondata);
        if (state.awaitDrain && (!dest._writableState || dest._writableState.needDrain))
          ondrain();
      }
      src.on('data', ondata);
      function ondata(chunk) {
        debug('ondata');
        var ret = dest.write(chunk);
        if (false === ret) {
          debug('false write response, pause', src._readableState.awaitDrain);
          src._readableState.awaitDrain++;
          src.pause();
        }
      }
      function onerror(er) {
        debug('onerror', er);
        unpipe();
        dest.removeListener('error', onerror);
        if (EE.listenerCount(dest, 'error') === 0)
          dest.emit('error', er);
      }
      if (!dest._events || !dest._events.error)
        dest.on('error', onerror);
      else if (isArray(dest._events.error))
        dest._events.error.unshift(onerror);
      else
        dest._events.error = [onerror, dest._events.error];
      function onclose() {
        dest.removeListener('finish', onfinish);
        unpipe();
      }
      dest.once('close', onclose);
      function onfinish() {
        debug('onfinish');
        dest.removeListener('close', onclose);
        unpipe();
      }
      dest.once('finish', onfinish);
      function unpipe() {
        debug('unpipe');
        src.unpipe(dest);
      }
      dest.emit('pipe', src);
      if (!state.flowing) {
        debug('pipe resume');
        src.resume();
      }
      return dest;
    };
    function pipeOnDrain(src) {
      return function() {
        var state = src._readableState;
        debug('pipeOnDrain', state.awaitDrain);
        if (state.awaitDrain)
          state.awaitDrain--;
        if (state.awaitDrain === 0 && EE.listenerCount(src, 'data')) {
          state.flowing = true;
          flow(src);
        }
      };
    }
    Readable.prototype.unpipe = function(dest) {
      var state = this._readableState;
      if (state.pipesCount === 0)
        return this;
      if (state.pipesCount === 1) {
        if (dest && dest !== state.pipes)
          return this;
        if (!dest)
          dest = state.pipes;
        state.pipes = null;
        state.pipesCount = 0;
        state.flowing = false;
        if (dest)
          dest.emit('unpipe', this);
        return this;
      }
      if (!dest) {
        var dests = state.pipes;
        var len = state.pipesCount;
        state.pipes = null;
        state.pipesCount = 0;
        state.flowing = false;
        for (var i = 0; i < len; i++)
          dests[i].emit('unpipe', this);
        return this;
      }
      var i = indexOf(state.pipes, dest);
      if (i === -1)
        return this;
      state.pipes.splice(i, 1);
      state.pipesCount -= 1;
      if (state.pipesCount === 1)
        state.pipes = state.pipes[0];
      dest.emit('unpipe', this);
      return this;
    };
    Readable.prototype.on = function(ev, fn) {
      var res = Stream.prototype.on.call(this, ev, fn);
      if (ev === 'data' && false !== this._readableState.flowing) {
        this.resume();
      }
      if (ev === 'readable' && this.readable) {
        var state = this._readableState;
        if (!state.readableListening) {
          state.readableListening = true;
          state.emittedReadable = false;
          state.needReadable = true;
          if (!state.reading) {
            var self = this;
            process.nextTick(function() {
              debug('readable nexttick read 0');
              self.read(0);
            });
          } else if (state.length) {
            emitReadable(this, state);
          }
        }
      }
      return res;
    };
    Readable.prototype.addListener = Readable.prototype.on;
    Readable.prototype.resume = function() {
      var state = this._readableState;
      if (!state.flowing) {
        debug('resume');
        state.flowing = true;
        if (!state.reading) {
          debug('resume read 0');
          this.read(0);
        }
        resume(this, state);
      }
      return this;
    };
    function resume(stream, state) {
      if (!state.resumeScheduled) {
        state.resumeScheduled = true;
        process.nextTick(function() {
          resume_(stream, state);
        });
      }
    }
    function resume_(stream, state) {
      state.resumeScheduled = false;
      stream.emit('resume');
      flow(stream);
      if (state.flowing && !state.reading)
        stream.read(0);
    }
    Readable.prototype.pause = function() {
      debug('call pause flowing=%j', this._readableState.flowing);
      if (false !== this._readableState.flowing) {
        debug('pause');
        this._readableState.flowing = false;
        this.emit('pause');
      }
      return this;
    };
    function flow(stream) {
      var state = stream._readableState;
      debug('flow', state.flowing);
      if (state.flowing) {
        do {
          var chunk = stream.read();
        } while (null !== chunk && state.flowing);
      }
    }
    Readable.prototype.wrap = function(stream) {
      var state = this._readableState;
      var paused = false;
      var self = this;
      stream.on('end', function() {
        debug('wrapped end');
        if (state.decoder && !state.ended) {
          var chunk = state.decoder.end();
          if (chunk && chunk.length)
            self.push(chunk);
        }
        self.push(null);
      });
      stream.on('data', function(chunk) {
        debug('wrapped data');
        if (state.decoder)
          chunk = state.decoder.write(chunk);
        if (!chunk || !state.objectMode && !chunk.length)
          return ;
        var ret = self.push(chunk);
        if (!ret) {
          paused = true;
          stream.pause();
        }
      });
      for (var i in stream) {
        if (util.isFunction(stream[i]) && util.isUndefined(this[i])) {
          this[i] = function(method) {
            return function() {
              return stream[method].apply(stream, arguments);
            };
          }(i);
        }
      }
      var events = ['error', 'close', 'destroy', 'pause', 'resume'];
      forEach(events, function(ev) {
        stream.on(ev, self.emit.bind(self, ev));
      });
      self._read = function(n) {
        debug('wrapped _read', n);
        if (paused) {
          paused = false;
          stream.resume();
        }
      };
      return self;
    };
    Readable._fromList = fromList;
    function fromList(n, state) {
      var list = state.buffer;
      var length = state.length;
      var stringMode = !!state.decoder;
      var objectMode = !!state.objectMode;
      var ret;
      if (list.length === 0)
        return null;
      if (length === 0)
        ret = null;
      else if (objectMode)
        ret = list.shift();
      else if (!n || n >= length) {
        if (stringMode)
          ret = list.join('');
        else
          ret = Buffer.concat(list, length);
        list.length = 0;
      } else {
        if (n < list[0].length) {
          var buf = list[0];
          ret = buf.slice(0, n);
          list[0] = buf.slice(n);
        } else if (n === list[0].length) {
          ret = list.shift();
        } else {
          if (stringMode)
            ret = '';
          else
            ret = new Buffer(n);
          var c = 0;
          for (var i = 0,
              l = list.length; i < l && c < n; i++) {
            var buf = list[0];
            var cpy = Math.min(n - c, buf.length);
            if (stringMode)
              ret += buf.slice(0, cpy);
            else
              buf.copy(ret, c, 0, cpy);
            if (cpy < buf.length)
              list[0] = buf.slice(cpy);
            else
              list.shift();
            c += cpy;
          }
        }
      }
      return ret;
    }
    function endReadable(stream) {
      var state = stream._readableState;
      if (state.length > 0)
        throw new Error('endReadable called on non-empty stream');
      if (!state.endEmitted) {
        state.ended = true;
        process.nextTick(function() {
          if (!state.endEmitted && state.length === 0) {
            state.endEmitted = true;
            stream.readable = false;
            stream.emit('end');
          }
        });
      }
    }
    function forEach(xs, f) {
      for (var i = 0,
          l = xs.length; i < l; i++) {
        f(xs[i], i);
      }
    }
    function indexOf(xs, x) {
      for (var i = 0,
          l = xs.length; i < l; i++) {
        if (xs[i] === x)
          return i;
      }
      return -1;
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer, require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/encrypter", ["npm:browserify-aes@1.0.0/aes", "npm:browserify-aes@1.0.0/cipherBase", "npm:inherits@2.0.1", "npm:browserify-aes@1.0.0/modes", "npm:browserify-aes@1.0.0/EVP_BytesToKey", "npm:browserify-aes@1.0.0/streamCipher", "npm:browserify-aes@1.0.0/authCipher", "npm:browserify-aes@1.0.0/modes/ecb", "npm:browserify-aes@1.0.0/modes/cbc", "npm:browserify-aes@1.0.0/modes/cfb", "npm:browserify-aes@1.0.0/modes/cfb8", "npm:browserify-aes@1.0.0/modes/cfb1", "npm:browserify-aes@1.0.0/modes/ofb", "npm:browserify-aes@1.0.0/modes/ctr", "npm:browserify-aes@1.0.0/modes/ctr", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var aes = require("npm:browserify-aes@1.0.0/aes");
    var Transform = require("npm:browserify-aes@1.0.0/cipherBase");
    var inherits = require("npm:inherits@2.0.1");
    var modes = require("npm:browserify-aes@1.0.0/modes");
    var ebtk = require("npm:browserify-aes@1.0.0/EVP_BytesToKey");
    var StreamCipher = require("npm:browserify-aes@1.0.0/streamCipher");
    var AuthCipher = require("npm:browserify-aes@1.0.0/authCipher");
    inherits(Cipher, Transform);
    function Cipher(mode, key, iv) {
      if (!(this instanceof Cipher)) {
        return new Cipher(mode, key, iv);
      }
      Transform.call(this);
      this._cache = new Splitter();
      this._cipher = new aes.AES(key);
      this._prev = new Buffer(iv.length);
      iv.copy(this._prev);
      this._mode = mode;
      this._autopadding = true;
    }
    Cipher.prototype._update = function(data) {
      this._cache.add(data);
      var chunk;
      var thing;
      var out = [];
      while ((chunk = this._cache.get())) {
        thing = this._mode.encrypt(this, chunk);
        out.push(thing);
      }
      return Buffer.concat(out);
    };
    Cipher.prototype._final = function() {
      var chunk = this._cache.flush();
      if (this._autopadding) {
        chunk = this._mode.encrypt(this, chunk);
        this._cipher.scrub();
        return chunk;
      } else if (chunk.toString('hex') !== '10101010101010101010101010101010') {
        this._cipher.scrub();
        throw new Error('data not multiple of block length');
      }
    };
    Cipher.prototype.setAutoPadding = function(setTo) {
      this._autopadding = !!setTo;
    };
    function Splitter() {
      if (!(this instanceof Splitter)) {
        return new Splitter();
      }
      this.cache = new Buffer('');
    }
    Splitter.prototype.add = function(data) {
      this.cache = Buffer.concat([this.cache, data]);
    };
    Splitter.prototype.get = function() {
      if (this.cache.length > 15) {
        var out = this.cache.slice(0, 16);
        this.cache = this.cache.slice(16);
        return out;
      }
      return null;
    };
    Splitter.prototype.flush = function() {
      var len = 16 - this.cache.length;
      var padBuff = new Buffer(len);
      var i = -1;
      while (++i < len) {
        padBuff.writeUInt8(len, i);
      }
      var out = Buffer.concat([this.cache, padBuff]);
      return out;
    };
    var modelist = {
      ECB: require("npm:browserify-aes@1.0.0/modes/ecb"),
      CBC: require("npm:browserify-aes@1.0.0/modes/cbc"),
      CFB: require("npm:browserify-aes@1.0.0/modes/cfb"),
      CFB8: require("npm:browserify-aes@1.0.0/modes/cfb8"),
      CFB1: require("npm:browserify-aes@1.0.0/modes/cfb1"),
      OFB: require("npm:browserify-aes@1.0.0/modes/ofb"),
      CTR: require("npm:browserify-aes@1.0.0/modes/ctr"),
      GCM: require("npm:browserify-aes@1.0.0/modes/ctr")
    };
    function createCipheriv(suite, password, iv) {
      var config = modes[suite.toLowerCase()];
      if (!config) {
        throw new TypeError('invalid suite type');
      }
      if (typeof iv === 'string') {
        iv = new Buffer(iv);
      }
      if (typeof password === 'string') {
        password = new Buffer(password);
      }
      if (password.length !== config.key / 8) {
        throw new TypeError('invalid key length ' + password.length);
      }
      if (iv.length !== config.iv) {
        throw new TypeError('invalid iv length ' + iv.length);
      }
      if (config.type === 'stream') {
        return new StreamCipher(modelist[config.mode], password, iv);
      } else if (config.type === 'auth') {
        return new AuthCipher(modelist[config.mode], password, iv);
      }
      return new Cipher(modelist[config.mode], password, iv);
    }
    function createCipher(suite, password) {
      var config = modes[suite.toLowerCase()];
      if (!config) {
        throw new TypeError('invalid suite type');
      }
      var keys = ebtk(password, config.key, config.iv);
      return createCipheriv(suite, keys.key, keys.iv);
    }
    exports.createCipheriv = createCipheriv;
    exports.createCipher = createCipher;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:miller-rabin@1.1.5/lib/mr", ["npm:bn.js@1.3.0", "npm:brorand@1.0.5"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var bn = require("npm:bn.js@1.3.0");
  var brorand = require("npm:brorand@1.0.5");
  function MillerRabin(rand) {
    this.rand = rand || new brorand.Rand();
  }
  module.exports = MillerRabin;
  MillerRabin.create = function create(rand) {
    return new MillerRabin(rand);
  };
  MillerRabin.prototype._rand = function _rand(n) {
    var len = n.bitLength();
    var buf = this.rand.generate(Math.ceil(len / 8));
    buf[0] |= 3;
    var mask = len & 0x7;
    if (mask !== 0)
      buf[buf.length - 1] >>= 7 - mask;
    return new bn(buf);
  };
  MillerRabin.prototype.test = function test(n, k, cb) {
    var len = n.bitLength();
    var red = bn.mont(n);
    var rone = new bn(1).toRed(red);
    if (!k)
      k = Math.max(1, (len / 48) | 0);
    var n1 = n.subn(1);
    var n2 = n1.subn(1);
    for (var s = 0; !n1.testn(s); s++) {}
    var d = n.shrn(s);
    var rn1 = n1.toRed(red);
    var prime = true;
    for (; k > 0; k--) {
      var a = this._rand(n2);
      if (cb)
        cb(a);
      var x = a.toRed(red).redPow(d);
      if (x.cmp(rone) === 0 || x.cmp(rn1) === 0)
        continue;
      for (var i = 1; i < s; i++) {
        x = x.redSqr();
        if (x.cmp(rone) === 0)
          return false;
        if (x.cmp(rn1) === 0)
          break;
      }
      if (i === s)
        return false;
    }
    return prime;
  };
  MillerRabin.prototype.getDivisor = function getDivisor(n, k) {
    var len = n.bitLength();
    var red = bn.mont(n);
    var rone = new bn(1).toRed(red);
    if (!k)
      k = Math.max(1, (len / 48) | 0);
    var n1 = n.subn(1);
    var n2 = n1.subn(1);
    for (var s = 0; !n1.testn(s); s++) {}
    var d = n.shrn(s);
    var rn1 = n1.toRed(red);
    var prime = true;
    for (; k > 0; k--) {
      var a = this._rand(n2);
      var g = n.gcd(a);
      if (g.cmpn(1) !== 0)
        return g;
      var x = a.toRed(red).redPow(d);
      if (x.cmp(rone) === 0 || x.cmp(rn1) === 0)
        continue;
      for (var i = 1; i < s; i++) {
        x = x.redSqr();
        if (x.cmp(rone) === 0)
          return x.fromRed().subn(1).gcd(n);
        if (x.cmp(rn1) === 0)
          break;
      }
      if (i === s) {
        x = x.redSqr();
        return x.fromRed().subn(1).gcd(n);
      }
    }
    return prime;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:vm-browserify@0.0.4/index", ["npm:indexof@0.0.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var indexOf = require("npm:indexof@0.0.1");
  var Object_keys = function(obj) {
    if (Object.keys)
      return Object.keys(obj);
    else {
      var res = [];
      for (var key in obj)
        res.push(key);
      return res;
    }
  };
  var forEach = function(xs, fn) {
    if (xs.forEach)
      return xs.forEach(fn);
    else
      for (var i = 0; i < xs.length; i++) {
        fn(xs[i], i, xs);
      }
  };
  var defineProp = (function() {
    try {
      Object.defineProperty({}, '_', {});
      return function(obj, name, value) {
        Object.defineProperty(obj, name, {
          writable: true,
          enumerable: false,
          configurable: true,
          value: value
        });
      };
    } catch (e) {
      return function(obj, name, value) {
        obj[name] = value;
      };
    }
  }());
  var globals = ['Array', 'Boolean', 'Date', 'Error', 'EvalError', 'Function', 'Infinity', 'JSON', 'Math', 'NaN', 'Number', 'Object', 'RangeError', 'ReferenceError', 'RegExp', 'String', 'SyntaxError', 'TypeError', 'URIError', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined', 'unescape'];
  function Context() {}
  Context.prototype = {};
  var Script = exports.Script = function NodeScript(code) {
    if (!(this instanceof Script))
      return new Script(code);
    this.code = code;
  };
  Script.prototype.runInContext = function(context) {
    if (!(context instanceof Context)) {
      throw new TypeError("needs a 'context' argument.");
    }
    var iframe = document.createElement('iframe');
    if (!iframe.style)
      iframe.style = {};
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
    var win = iframe.contentWindow;
    var wEval = win.eval,
        wExecScript = win.execScript;
    if (!wEval && wExecScript) {
      wExecScript.call(win, 'null');
      wEval = win.eval;
    }
    forEach(Object_keys(context), function(key) {
      win[key] = context[key];
    });
    forEach(globals, function(key) {
      if (context[key]) {
        win[key] = context[key];
      }
    });
    var winKeys = Object_keys(win);
    var res = wEval.call(win, this.code);
    forEach(Object_keys(win), function(key) {
      if (key in context || indexOf(winKeys, key) === -1) {
        context[key] = win[key];
      }
    });
    forEach(globals, function(key) {
      if (!(key in context)) {
        defineProp(context, key, win[key]);
      }
    });
    document.body.removeChild(iframe);
    return res;
  };
  Script.prototype.runInThisContext = function() {
    return eval(this.code);
  };
  Script.prototype.runInNewContext = function(context) {
    var ctx = Script.createContext(context);
    var res = this.runInContext(ctx);
    forEach(Object_keys(ctx), function(key) {
      context[key] = ctx[key];
    });
    return res;
  };
  forEach(Object_keys(Script.prototype), function(name) {
    exports[name] = Script[name] = function(code) {
      var s = Script(code);
      return s[name].apply(s, [].slice.call(arguments, 1));
    };
  });
  exports.createScript = function(code) {
    return exports.Script(code);
  };
  exports.createContext = Script.createContext = function(context) {
    var copy = new Context();
    if (typeof context === 'object') {
      forEach(Object_keys(context), function(key) {
        copy[key] = context[key];
      });
    }
    return copy;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1/base/node", ["npm:asn1.js@1.0.4/lib/asn1/base/index", "npm:asn1.js@1.0.4/lib/asn1/base/index", "npm:minimalistic-assert@1.0.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var Reporter = require("npm:asn1.js@1.0.4/lib/asn1/base/index").Reporter;
  var EncoderBuffer = require("npm:asn1.js@1.0.4/lib/asn1/base/index").EncoderBuffer;
  var assert = require("npm:minimalistic-assert@1.0.0");
  var tags = ['seq', 'seqof', 'set', 'setof', 'octstr', 'bitstr', 'objid', 'bool', 'gentime', 'utctime', 'null_', 'enum', 'int', 'ia5str'];
  var methods = ['key', 'obj', 'use', 'optional', 'explicit', 'implicit', 'def', 'choice', 'any'].concat(tags);
  var overrided = ['_peekTag', '_decodeTag', '_use', '_decodeStr', '_decodeObjid', '_decodeTime', '_decodeNull', '_decodeInt', '_decodeBool', '_decodeList', '_encodeComposite', '_encodeStr', '_encodeObjid', '_encodeTime', '_encodeNull', '_encodeInt', '_encodeBool'];
  function Node(enc, parent) {
    var state = {};
    this._baseState = state;
    state.enc = enc;
    state.parent = parent || null;
    state.children = null;
    state.tag = null;
    state.args = null;
    state.reverseArgs = null;
    state.choice = null;
    state.optional = false;
    state.any = false;
    state.obj = false;
    state.use = null;
    state.useDecoder = null;
    state.key = null;
    state['default'] = null;
    state.explicit = null;
    state.implicit = null;
    if (!state.parent) {
      state.children = [];
      this._wrap();
    }
  }
  module.exports = Node;
  var stateProps = ['enc', 'parent', 'children', 'tag', 'args', 'reverseArgs', 'choice', 'optional', 'any', 'obj', 'use', 'alteredUse', 'key', 'default', 'explicit', 'implicit'];
  Node.prototype.clone = function clone() {
    var state = this._baseState;
    var cstate = {};
    stateProps.forEach(function(prop) {
      cstate[prop] = state[prop];
    });
    var res = new this.constructor(cstate.parent);
    res._baseState = cstate;
    return res;
  };
  Node.prototype._wrap = function wrap() {
    var state = this._baseState;
    methods.forEach(function(method) {
      this[method] = function _wrappedMethod() {
        var clone = new this.constructor(this);
        state.children.push(clone);
        return clone[method].apply(clone, arguments);
      };
    }, this);
  };
  Node.prototype._init = function init(body) {
    var state = this._baseState;
    assert(state.parent === null);
    body.call(this);
    state.children = state.children.filter(function(child) {
      return child._baseState.parent === this;
    }, this);
    assert.equal(state.children.length, 1, 'Root node can have only one child');
  };
  Node.prototype._useArgs = function useArgs(args) {
    var state = this._baseState;
    var children = args.filter(function(arg) {
      return arg instanceof this.constructor;
    }, this);
    args = args.filter(function(arg) {
      return !(arg instanceof this.constructor);
    }, this);
    if (children.length !== 0) {
      assert(state.children === null);
      state.children = children;
      children.forEach(function(child) {
        child._baseState.parent = this;
      }, this);
    }
    if (args.length !== 0) {
      assert(state.args === null);
      state.args = args;
      state.reverseArgs = args.map(function(arg) {
        if (typeof arg !== 'object' || arg.constructor !== Object)
          return arg;
        var res = {};
        Object.keys(arg).forEach(function(key) {
          if (key == (key | 0))
            key |= 0;
          var value = arg[key];
          res[value] = key;
        });
        return res;
      });
    }
  };
  overrided.forEach(function(method) {
    Node.prototype[method] = function _overrided() {
      var state = this._baseState;
      throw new Error(method + ' not implemented for encoding: ' + state.enc);
    };
  });
  tags.forEach(function(tag) {
    Node.prototype[tag] = function _tagMethod() {
      var state = this._baseState;
      var args = Array.prototype.slice.call(arguments);
      assert(state.tag === null);
      state.tag = tag;
      this._useArgs(args);
      return this;
    };
  });
  Node.prototype.use = function use(item) {
    var state = this._baseState;
    assert(state.use === null);
    state.use = item;
    return this;
  };
  Node.prototype.optional = function optional() {
    var state = this._baseState;
    state.optional = true;
    return this;
  };
  Node.prototype.def = function def(val) {
    var state = this._baseState;
    assert(state['default'] === null);
    state['default'] = val;
    state.optional = true;
    return this;
  };
  Node.prototype.explicit = function explicit(num) {
    var state = this._baseState;
    assert(state.explicit === null && state.implicit === null);
    state.explicit = num;
    return this;
  };
  Node.prototype.implicit = function implicit(num) {
    var state = this._baseState;
    assert(state.explicit === null && state.implicit === null);
    state.implicit = num;
    return this;
  };
  Node.prototype.obj = function obj() {
    var state = this._baseState;
    var args = Array.prototype.slice.call(arguments);
    state.obj = true;
    if (args.length !== 0)
      this._useArgs(args);
    return this;
  };
  Node.prototype.key = function key(newKey) {
    var state = this._baseState;
    assert(state.key === null);
    state.key = newKey;
    return this;
  };
  Node.prototype.any = function any() {
    var state = this._baseState;
    state.any = true;
    return this;
  };
  Node.prototype.choice = function choice(obj) {
    var state = this._baseState;
    assert(state.choice === null);
    state.choice = obj;
    this._useArgs(Object.keys(obj).map(function(key) {
      return obj[key];
    }));
    return this;
  };
  Node.prototype._decode = function decode(input) {
    var state = this._baseState;
    if (state.parent === null)
      return input.wrapResult(state.children[0]._decode(input));
    var result = state['default'];
    var present = true;
    var prevKey;
    if (state.key !== null)
      prevKey = input.enterKey(state.key);
    if (state.optional) {
      present = this._peekTag(input, state.explicit !== null ? state.explicit : state.implicit !== null ? state.implicit : state.tag || 0);
      if (input.isError(present))
        return present;
    }
    var prevObj;
    if (state.obj && present)
      prevObj = input.enterObject();
    if (present) {
      if (state.explicit !== null) {
        var explicit = this._decodeTag(input, state.explicit);
        if (input.isError(explicit))
          return explicit;
        input = explicit;
      }
      if (state.use === null && state.choice === null) {
        if (state.any)
          var save = input.save();
        var body = this._decodeTag(input, state.implicit !== null ? state.implicit : state.tag, state.any);
        if (input.isError(body))
          return body;
        if (state.any)
          result = input.raw(save);
        else
          input = body;
      }
      if (state.any)
        result = result;
      else if (state.choice === null)
        result = this._decodeGeneric(state.tag, input);
      else
        result = this._decodeChoice(input);
      if (input.isError(result))
        return result;
      if (!state.any && state.choice === null && state.children !== null) {
        var fail = state.children.some(function decodeChildren(child) {
          child._decode(input);
        });
        if (fail)
          return err;
      }
    }
    if (state.obj && present)
      result = input.leaveObject(prevObj);
    if (state.key !== null && (result !== null || present === true))
      input.leaveKey(prevKey, state.key, result);
    return result;
  };
  Node.prototype._decodeGeneric = function decodeGeneric(tag, input) {
    var state = this._baseState;
    if (tag === 'seq' || tag === 'set')
      return null;
    if (tag === 'seqof' || tag === 'setof')
      return this._decodeList(input, tag, state.args[0]);
    else if (tag === 'octstr' || tag === 'bitstr' || tag === 'ia5str')
      return this._decodeStr(input, tag);
    else if (tag === 'objid' && state.args)
      return this._decodeObjid(input, state.args[0], state.args[1]);
    else if (tag === 'objid')
      return this._decodeObjid(input, null, null);
    else if (tag === 'gentime' || tag === 'utctime')
      return this._decodeTime(input, tag);
    else if (tag === 'null_')
      return this._decodeNull(input);
    else if (tag === 'bool')
      return this._decodeBool(input);
    else if (tag === 'int' || tag === 'enum')
      return this._decodeInt(input, state.args && state.args[0]);
    else if (state.use !== null)
      return this._getUse(state.use, input._reporterState.obj)._decode(input);
    else
      return input.error('unknown tag: ' + tag);
    return null;
  };
  Node.prototype._getUse = function _getUse(entity, obj) {
    var state = this._baseState;
    state.useDecoder = this._use(entity, obj);
    assert(state.useDecoder._baseState.parent === null);
    state.useDecoder = state.useDecoder._baseState.children[0];
    if (state.implicit !== state.useDecoder._baseState.implicit) {
      state.useDecoder = state.useDecoder.clone();
      state.useDecoder._baseState.implicit = state.implicit;
    }
    return state.useDecoder;
  };
  Node.prototype._decodeChoice = function decodeChoice(input) {
    var state = this._baseState;
    var result = null;
    var match = false;
    Object.keys(state.choice).some(function(key) {
      var save = input.save();
      var node = state.choice[key];
      try {
        var value = node._decode(input);
        if (input.isError(value))
          return false;
        result = {
          type: key,
          value: value
        };
        match = true;
      } catch (e) {
        input.restore(save);
        return false;
      }
      return true;
    }, this);
    if (!match)
      return input.error('Choice not matched');
    return result;
  };
  Node.prototype._createEncoderBuffer = function createEncoderBuffer(data) {
    return new EncoderBuffer(data, this.reporter);
  };
  Node.prototype._encode = function encode(data, reporter, parent) {
    var state = this._baseState;
    if (state['default'] !== null && state['default'] === data)
      return ;
    var result = this._encodeValue(data, reporter, parent);
    if (result === undefined)
      return ;
    if (this._skipDefault(result, reporter, parent))
      return ;
    return result;
  };
  Node.prototype._encodeValue = function encode(data, reporter, parent) {
    var state = this._baseState;
    if (state.parent === null)
      return state.children[0]._encode(data, reporter || new Reporter());
    var result = null;
    var present = true;
    this.reporter = reporter;
    if (state.optional && data === undefined) {
      if (state['default'] !== null)
        data = state['default'];
      else
        return ;
    }
    var prevKey;
    var content = null;
    var primitive = false;
    if (state.any) {
      result = this._createEncoderBuffer(data);
    } else if (state.choice) {
      result = this._encodeChoice(data, reporter);
    } else if (state.children) {
      content = state.children.map(function(child) {
        if (child._baseState.tag === 'null_')
          return child._encode(null, reporter, data);
        if (child._baseState.key === null)
          return reporter.error('Child should have a key');
        var prevKey = reporter.enterKey(child._baseState.key);
        if (typeof data !== 'object')
          return reporter.error('Child expected, but input is not object');
        var res = child._encode(data[child._baseState.key], reporter, data);
        reporter.leaveKey(prevKey);
        return res;
      }, this).filter(function(child) {
        return child;
      });
      content = this._createEncoderBuffer(content);
    } else {
      if (state.tag === 'seqof' || state.tag === 'setof') {
        if (!(state.args && state.args.length === 1))
          return reporter.error('Too many args for : ' + state.tag);
        if (!Array.isArray(data))
          return reporter.error('seqof/setof, but data is not Array');
        var child = this.clone();
        child._baseState.implicit = null;
        content = this._createEncoderBuffer(data.map(function(item) {
          var state = this._baseState;
          return this._getUse(state.args[0], data)._encode(item, reporter);
        }, child));
      } else if (state.use !== null) {
        result = this._getUse(state.use, parent)._encode(data, reporter);
      } else {
        content = this._encodePrimitive(state.tag, data);
        primitive = true;
      }
    }
    var result;
    if (!state.any && state.choice === null) {
      var tag = state.implicit !== null ? state.implicit : state.tag;
      var cls = state.implicit === null ? 'universal' : 'context';
      if (tag === null) {
        if (state.use === null)
          reporter.error('Tag could be ommited only for .use()');
      } else {
        if (state.use === null)
          result = this._encodeComposite(tag, primitive, cls, content);
      }
    }
    if (state.explicit !== null)
      result = this._encodeComposite(state.explicit, false, 'context', result);
    return result;
  };
  Node.prototype._encodeChoice = function encodeChoice(data, reporter) {
    var state = this._baseState;
    var node = state.choice[data.type];
    if (!node) {
      assert(false, data.type + ' not found in ' + JSON.stringify(Object.keys(state.choice)));
    }
    return node._encode(data.value, reporter);
  };
  Node.prototype._encodePrimitive = function encodePrimitive(tag, data) {
    var state = this._baseState;
    if (tag === 'octstr' || tag === 'bitstr' || tag === 'ia5str')
      return this._encodeStr(data, tag);
    else if (tag === 'objid' && state.args)
      return this._encodeObjid(data, state.reverseArgs[0], state.args[1]);
    else if (tag === 'objid')
      return this._encodeObjid(data, null, null);
    else if (tag === 'gentime' || tag === 'utctime')
      return this._encodeTime(data, tag);
    else if (tag === 'null_')
      return this._encodeNull();
    else if (tag === 'int' || tag === 'enum')
      return this._encodeInt(data, state.args && state.reverseArgs[0]);
    else if (tag === 'bool')
      return this._encodeBool(data);
    else
      throw new Error('Unsupported tag: ' + tag);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:hash.js@1.0.2", ["npm:hash.js@1.0.2/lib/hash"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:hash.js@1.0.2/lib/hash");
  global.define = __define;
  return module.exports;
});

System.register("npm:create-ecdh@2.0.0", ["npm:create-ecdh@2.0.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:create-ecdh@2.0.0/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:public-encrypt@2.0.0/browser", ["npm:public-encrypt@2.0.0/publicEncrypt", "npm:public-encrypt@2.0.0/privateDecrypt"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  exports.publicEncrypt = require("npm:public-encrypt@2.0.0/publicEncrypt");
  exports.privateDecrypt = require("npm:public-encrypt@2.0.0/privateDecrypt");
  exports.privateEncrypt = function privateEncrypt(key, buf) {
    return exports.publicEncrypt(key, buf, true);
  };
  exports.publicDecrypt = function publicDecrypt(key, buf) {
    return exports.privateDecrypt(key, buf, true);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/fn/map", ["npm:core-js@0.9.6/library/modules/es6.object.to-string", "npm:core-js@0.9.6/library/modules/es6.string.iterator", "npm:core-js@0.9.6/library/modules/web.dom.iterable", "npm:core-js@0.9.6/library/modules/es6.map", "npm:core-js@0.9.6/library/modules/es7.map.to-json", "npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/library/modules/es6.object.to-string");
  require("npm:core-js@0.9.6/library/modules/es6.string.iterator");
  require("npm:core-js@0.9.6/library/modules/web.dom.iterable");
  require("npm:core-js@0.9.6/library/modules/es6.map");
  require("npm:core-js@0.9.6/library/modules/es7.map.to-json");
  module.exports = require("npm:core-js@0.9.6/library/modules/$").core.Map;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/fn/object/assign", ["npm:core-js@0.9.6/library/modules/es6.object.assign", "npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/library/modules/es6.object.assign");
  module.exports = require("npm:core-js@0.9.6/library/modules/$").core.Object.assign;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/es6.string.iterator", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.string-at", "npm:core-js@0.9.6/library/modules/$.uid", "npm:core-js@0.9.6/library/modules/$.iter", "npm:core-js@0.9.6/library/modules/$.iter-define"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var set = require("npm:core-js@0.9.6/library/modules/$").set,
      $at = require("npm:core-js@0.9.6/library/modules/$.string-at")(true),
      ITER = require("npm:core-js@0.9.6/library/modules/$.uid").safe('iter'),
      $iter = require("npm:core-js@0.9.6/library/modules/$.iter"),
      step = $iter.step;
  require("npm:core-js@0.9.6/library/modules/$.iter-define")(String, 'String', function(iterated) {
    set(this, ITER, {
      o: String(iterated),
      i: 0
    });
  }, function() {
    var iter = this[ITER],
        O = iter.o,
        index = iter.i,
        point;
    if (index >= O.length)
      return step(1);
    point = $at(O, index);
    iter.i += point.length;
    return step(0, point);
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/fn/is-iterable", ["npm:core-js@0.9.6/library/modules/web.dom.iterable", "npm:core-js@0.9.6/library/modules/es6.string.iterator", "npm:core-js@0.9.6/library/modules/core.iter-helpers", "npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/library/modules/web.dom.iterable");
  require("npm:core-js@0.9.6/library/modules/es6.string.iterator");
  require("npm:core-js@0.9.6/library/modules/core.iter-helpers");
  module.exports = require("npm:core-js@0.9.6/library/modules/$").core.isIterable;
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-process@0.1.1", ["github:jspm/nodelibs-process@0.1.1/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:jspm/nodelibs-process@0.1.1/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/modules/es5", ["npm:core-js@0.9.6/modules/$", "npm:core-js@0.9.6/modules/$.dom-create", "npm:core-js@0.9.6/modules/$.cof", "npm:core-js@0.9.6/modules/$.def", "npm:core-js@0.9.6/modules/$.invoke", "npm:core-js@0.9.6/modules/$.array-methods", "npm:core-js@0.9.6/modules/$.uid", "npm:core-js@0.9.6/modules/$.assert", "npm:core-js@0.9.6/modules/$.array-includes", "npm:core-js@0.9.6/modules/$.replacer", "npm:core-js@0.9.6/modules/$.throws"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var $ = require("npm:core-js@0.9.6/modules/$"),
      cel = require("npm:core-js@0.9.6/modules/$.dom-create"),
      cof = require("npm:core-js@0.9.6/modules/$.cof"),
      $def = require("npm:core-js@0.9.6/modules/$.def"),
      invoke = require("npm:core-js@0.9.6/modules/$.invoke"),
      arrayMethod = require("npm:core-js@0.9.6/modules/$.array-methods"),
      IE_PROTO = require("npm:core-js@0.9.6/modules/$.uid").safe('__proto__'),
      assert = require("npm:core-js@0.9.6/modules/$.assert"),
      assertObject = assert.obj,
      ObjectProto = Object.prototype,
      A = [],
      slice = A.slice,
      indexOf = A.indexOf,
      classof = cof.classof,
      has = $.has,
      defineProperty = $.setDesc,
      getOwnDescriptor = $.getDesc,
      defineProperties = $.setDescs,
      isFunction = $.isFunction,
      toObject = $.toObject,
      toLength = $.toLength,
      IE8_DOM_DEFINE = false,
      $indexOf = require("npm:core-js@0.9.6/modules/$.array-includes")(false),
      $forEach = arrayMethod(0),
      $map = arrayMethod(1),
      $filter = arrayMethod(2),
      $some = arrayMethod(3),
      $every = arrayMethod(4);
  if (!$.DESC) {
    try {
      IE8_DOM_DEFINE = defineProperty(cel('div'), 'x', {get: function() {
          return 8;
        }}).x == 8;
    } catch (e) {}
    $.setDesc = function(O, P, Attributes) {
      if (IE8_DOM_DEFINE)
        try {
          return defineProperty(O, P, Attributes);
        } catch (e) {}
      if ('get' in Attributes || 'set' in Attributes)
        throw TypeError('Accessors not supported!');
      if ('value' in Attributes)
        assertObject(O)[P] = Attributes.value;
      return O;
    };
    $.getDesc = function(O, P) {
      if (IE8_DOM_DEFINE)
        try {
          return getOwnDescriptor(O, P);
        } catch (e) {}
      if (has(O, P))
        return $.desc(!ObjectProto.propertyIsEnumerable.call(O, P), O[P]);
    };
    $.setDescs = defineProperties = function(O, Properties) {
      assertObject(O);
      var keys = $.getKeys(Properties),
          length = keys.length,
          i = 0,
          P;
      while (length > i)
        $.setDesc(O, P = keys[i++], Properties[P]);
      return O;
    };
  }
  $def($def.S + $def.F * !$.DESC, 'Object', {
    getOwnPropertyDescriptor: $.getDesc,
    defineProperty: $.setDesc,
    defineProperties: defineProperties
  });
  var keys1 = ('constructor,hasOwnProperty,isPrototypeOf,propertyIsEnumerable,' + 'toLocaleString,toString,valueOf').split(','),
      keys2 = keys1.concat('length', 'prototype'),
      keysLen1 = keys1.length;
  var createDict = function() {
    var iframe = cel('iframe'),
        i = keysLen1,
        gt = '>',
        iframeDocument;
    iframe.style.display = 'none';
    $.html.appendChild(iframe);
    iframe.src = 'javascript:';
    iframeDocument = iframe.contentWindow.document;
    iframeDocument.open();
    iframeDocument.write('<script>document.F=Object</script' + gt);
    iframeDocument.close();
    createDict = iframeDocument.F;
    while (i--)
      delete createDict.prototype[keys1[i]];
    return createDict();
  };
  function createGetKeys(names, length) {
    return function(object) {
      var O = toObject(object),
          i = 0,
          result = [],
          key;
      for (key in O)
        if (key != IE_PROTO)
          has(O, key) && result.push(key);
      while (length > i)
        if (has(O, key = names[i++])) {
          ~indexOf.call(result, key) || result.push(key);
        }
      return result;
    };
  }
  function isPrimitive(it) {
    return !$.isObject(it);
  }
  function Empty() {}
  $def($def.S, 'Object', {
    getPrototypeOf: $.getProto = $.getProto || function(O) {
      O = Object(assert.def(O));
      if (has(O, IE_PROTO))
        return O[IE_PROTO];
      if (isFunction(O.constructor) && O instanceof O.constructor) {
        return O.constructor.prototype;
      }
      return O instanceof Object ? ObjectProto : null;
    },
    getOwnPropertyNames: $.getNames = $.getNames || createGetKeys(keys2, keys2.length, true),
    create: $.create = $.create || function(O, Properties) {
      var result;
      if (O !== null) {
        Empty.prototype = assertObject(O);
        result = new Empty();
        Empty.prototype = null;
        result[IE_PROTO] = O;
      } else
        result = createDict();
      return Properties === undefined ? result : defineProperties(result, Properties);
    },
    keys: $.getKeys = $.getKeys || createGetKeys(keys1, keysLen1, false),
    seal: $.it,
    freeze: $.it,
    preventExtensions: $.it,
    isSealed: isPrimitive,
    isFrozen: isPrimitive,
    isExtensible: $.isObject
  });
  $def($def.P, 'Function', {bind: function(that) {
      var fn = assert.fn(this),
          partArgs = slice.call(arguments, 1);
      function bound() {
        var args = partArgs.concat(slice.call(arguments));
        return invoke(fn, args, this instanceof bound ? $.create(fn.prototype) : that);
      }
      if (fn.prototype)
        bound.prototype = fn.prototype;
      return bound;
    }});
  function arrayMethodFix(fn) {
    return function() {
      return fn.apply($.ES5Object(this), arguments);
    };
  }
  if (!(0 in Object('z') && 'z'[0] == 'z')) {
    $.ES5Object = function(it) {
      return cof(it) == 'String' ? it.split('') : Object(it);
    };
  }
  $def($def.P + $def.F * ($.ES5Object != Object), 'Array', {
    slice: arrayMethodFix(slice),
    join: arrayMethodFix(A.join)
  });
  $def($def.S, 'Array', {isArray: function(arg) {
      return cof(arg) == 'Array';
    }});
  function createArrayReduce(isRight) {
    return function(callbackfn, memo) {
      assert.fn(callbackfn);
      var O = toObject(this),
          length = toLength(O.length),
          index = isRight ? length - 1 : 0,
          i = isRight ? -1 : 1;
      if (arguments.length < 2)
        for (; ; ) {
          if (index in O) {
            memo = O[index];
            index += i;
            break;
          }
          index += i;
          assert(isRight ? index >= 0 : length > index, 'Reduce of empty array with no initial value');
        }
      for (; isRight ? index >= 0 : length > index; index += i)
        if (index in O) {
          memo = callbackfn(memo, O[index], index, this);
        }
      return memo;
    };
  }
  $def($def.P, 'Array', {
    forEach: $.each = $.each || function forEach(callbackfn) {
      return $forEach(this, callbackfn, arguments[1]);
    },
    map: function map(callbackfn) {
      return $map(this, callbackfn, arguments[1]);
    },
    filter: function filter(callbackfn) {
      return $filter(this, callbackfn, arguments[1]);
    },
    some: function some(callbackfn) {
      return $some(this, callbackfn, arguments[1]);
    },
    every: function every(callbackfn) {
      return $every(this, callbackfn, arguments[1]);
    },
    reduce: createArrayReduce(false),
    reduceRight: createArrayReduce(true),
    indexOf: indexOf = indexOf || function indexOf(el) {
      return $indexOf(this, el, arguments[1]);
    },
    lastIndexOf: function(el, fromIndex) {
      var O = toObject(this),
          length = toLength(O.length),
          index = length - 1;
      if (arguments.length > 1)
        index = Math.min(index, $.toInteger(fromIndex));
      if (index < 0)
        index = toLength(length + index);
      for (; index >= 0; index--)
        if (index in O)
          if (O[index] === el)
            return index;
      return -1;
    }
  });
  $def($def.P, 'String', {trim: require("npm:core-js@0.9.6/modules/$.replacer")(/^\s*([\s\S]*\S)?\s*$/, '$1')});
  $def($def.S, 'Date', {now: function() {
      return +new Date;
    }});
  function lz(num) {
    return num > 9 ? num : '0' + num;
  }
  var date = new Date(-5e13 - 1),
      brokenDate = !(date.toISOString && date.toISOString() == '0385-07-25T07:06:39.999Z' && require("npm:core-js@0.9.6/modules/$.throws")(function() {
        new Date(NaN).toISOString();
      }));
  $def($def.P + $def.F * brokenDate, 'Date', {toISOString: function() {
      if (!isFinite(this))
        throw RangeError('Invalid time value');
      var d = this,
          y = d.getUTCFullYear(),
          m = d.getUTCMilliseconds(),
          s = y < 0 ? '-' : y > 9999 ? '+' : '';
      return s + ('00000' + Math.abs(y)).slice(s ? -6 : -4) + '-' + lz(d.getUTCMonth() + 1) + '-' + lz(d.getUTCDate()) + 'T' + lz(d.getUTCHours()) + ':' + lz(d.getUTCMinutes()) + ':' + lz(d.getUTCSeconds()) + '.' + (m > 99 ? m : '0' + lz(m)) + 'Z';
    }});
  if (classof(function() {
    return arguments;
  }()) == 'Object')
    cof.classof = function(it) {
      var tag = classof(it);
      return tag == 'Object' && isFunction(it.callee) ? 'Arguments' : tag;
    };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/fn/symbol", ["npm:core-js@0.9.6/library/fn/symbol/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:core-js@0.9.6/library/fn/symbol/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:buffer@3.2.2", ["npm:buffer@3.2.2/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:buffer@3.2.2/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:sha.js@2.4.0", ["npm:sha.js@2.4.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:sha.js@2.4.0/index");
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-events@0.1.0", ["github:jspm/nodelibs-events@0.1.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:jspm/nodelibs-events@0.1.0/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:readable-stream@1.1.13/readable", ["npm:readable-stream@1.1.13/lib/_stream_readable", "npm:stream-browserify@1.0.0/index", "npm:readable-stream@1.1.13/lib/_stream_writable", "npm:readable-stream@1.1.13/lib/_stream_duplex", "npm:readable-stream@1.1.13/lib/_stream_transform", "npm:readable-stream@1.1.13/lib/_stream_passthrough"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  exports = module.exports = require("npm:readable-stream@1.1.13/lib/_stream_readable");
  exports.Stream = require("npm:stream-browserify@1.0.0/index");
  exports.Readable = exports;
  exports.Writable = require("npm:readable-stream@1.1.13/lib/_stream_writable");
  exports.Duplex = require("npm:readable-stream@1.1.13/lib/_stream_duplex");
  exports.Transform = require("npm:readable-stream@1.1.13/lib/_stream_transform");
  exports.PassThrough = require("npm:readable-stream@1.1.13/lib/_stream_passthrough");
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0/browser", ["npm:browserify-aes@1.0.0/encrypter", "npm:browserify-aes@1.0.0/decrypter", "npm:browserify-aes@1.0.0/modes"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var ciphers = require("npm:browserify-aes@1.0.0/encrypter");
  exports.createCipher = exports.Cipher = ciphers.createCipher;
  exports.createCipheriv = exports.Cipheriv = ciphers.createCipheriv;
  var deciphers = require("npm:browserify-aes@1.0.0/decrypter");
  exports.createDecipher = exports.Decipher = deciphers.createDecipher;
  exports.createDecipheriv = exports.Decipheriv = deciphers.createDecipheriv;
  var modes = require("npm:browserify-aes@1.0.0/modes");
  function getCiphers() {
    return Object.keys(modes);
  }
  exports.listCiphers = exports.getCiphers = getCiphers;
  global.define = __define;
  return module.exports;
});

System.register("npm:miller-rabin@1.1.5", ["npm:miller-rabin@1.1.5/lib/mr"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:miller-rabin@1.1.5/lib/mr");
  global.define = __define;
  return module.exports;
});

System.register("npm:vm-browserify@0.0.4", ["npm:vm-browserify@0.0.4/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:vm-browserify@0.0.4/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1/base/index", ["npm:asn1.js@1.0.4/lib/asn1/base/reporter", "npm:asn1.js@1.0.4/lib/asn1/base/buffer", "npm:asn1.js@1.0.4/lib/asn1/base/buffer", "npm:asn1.js@1.0.4/lib/asn1/base/node"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var base = exports;
  base.Reporter = require("npm:asn1.js@1.0.4/lib/asn1/base/reporter").Reporter;
  base.DecoderBuffer = require("npm:asn1.js@1.0.4/lib/asn1/base/buffer").DecoderBuffer;
  base.EncoderBuffer = require("npm:asn1.js@1.0.4/lib/asn1/base/buffer").EncoderBuffer;
  base.Node = require("npm:asn1.js@1.0.4/lib/asn1/base/node");
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic/hmac-drbg", ["npm:hash.js@1.0.2", "npm:elliptic@1.0.1/lib/elliptic"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var hash = require("npm:hash.js@1.0.2");
  var elliptic = require("npm:elliptic@1.0.1/lib/elliptic");
  var utils = elliptic.utils;
  var assert = utils.assert;
  function HmacDRBG(options) {
    if (!(this instanceof HmacDRBG))
      return new HmacDRBG(options);
    this.hash = options.hash;
    this.predResist = !!options.predResist;
    this.outLen = this.hash.outSize;
    this.minEntropy = options.minEntropy || this.hash.hmacStrength;
    this.reseed = null;
    this.reseedInterval = null;
    this.K = null;
    this.V = null;
    var entropy = utils.toArray(options.entropy, options.entropyEnc);
    var nonce = utils.toArray(options.nonce, options.nonceEnc);
    var pers = utils.toArray(options.pers, options.persEnc);
    assert(entropy.length >= (this.minEntropy / 8), 'Not enough entropy. Minimum is: ' + this.minEntropy + ' bits');
    this._init(entropy, nonce, pers);
  }
  module.exports = HmacDRBG;
  HmacDRBG.prototype._init = function init(entropy, nonce, pers) {
    var seed = entropy.concat(nonce).concat(pers);
    this.K = new Array(this.outLen / 8);
    this.V = new Array(this.outLen / 8);
    for (var i = 0; i < this.V.length; i++) {
      this.K[i] = 0x00;
      this.V[i] = 0x01;
    }
    this._update(seed);
    this.reseed = 1;
    this.reseedInterval = 0x1000000000000;
  };
  HmacDRBG.prototype._hmac = function hmac() {
    return new hash.hmac(this.hash, this.K);
  };
  HmacDRBG.prototype._update = function update(seed) {
    var kmac = this._hmac().update(this.V).update([0x00]);
    if (seed)
      kmac = kmac.update(seed);
    this.K = kmac.digest();
    this.V = this._hmac().update(this.V).digest();
    if (!seed)
      return ;
    this.K = this._hmac().update(this.V).update([0x01]).update(seed).digest();
    this.V = this._hmac().update(this.V).digest();
  };
  HmacDRBG.prototype.reseed = function reseed(entropy, entropyEnc, add, addEnc) {
    if (typeof entropyEnc !== 'string') {
      addEnc = add;
      add = entropyEnc;
      entropyEnc = null;
    }
    entropy = utils.toBuffer(entropy, entropyEnc);
    add = utils.toBuffer(add, addEnc);
    assert(entropy.length >= (this.minEntropy / 8), 'Not enough entropy. Minimum is: ' + this.minEntropy + ' bits');
    this._update(entropy.concat(add || []));
    this.reseed = 1;
  };
  HmacDRBG.prototype.generate = function generate(len, enc, add, addEnc) {
    if (this.reseed > this.reseedInterval)
      throw new Error('Reseed is required');
    if (typeof enc !== 'string') {
      addEnc = add;
      add = enc;
      enc = null;
    }
    if (add) {
      add = utils.toArray(add, addEnc);
      this._update(add);
    }
    var temp = [];
    while (temp.length < len) {
      this.V = this._hmac().update(this.V).digest();
      temp = temp.concat(this.V);
    }
    var res = temp.slice(0, len);
    this._update(add);
    this.reseed++;
    return utils.encode(res, enc);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:public-encrypt@2.0.0", ["npm:public-encrypt@2.0.0/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:public-encrypt@2.0.0/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/core-js/map", ["npm:core-js@0.9.6/library/fn/map"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.6/library/fn/map"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/core-js/object/assign", ["npm:core-js@0.9.6/library/fn/object/assign"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.6/library/fn/object/assign"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/fn/array/from", ["npm:core-js@0.9.6/library/modules/es6.string.iterator", "npm:core-js@0.9.6/library/modules/es6.array.from", "npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/library/modules/es6.string.iterator");
  require("npm:core-js@0.9.6/library/modules/es6.array.from");
  module.exports = require("npm:core-js@0.9.6/library/modules/$").core.Array.from;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/core-js/is-iterable", ["npm:core-js@0.9.6/library/fn/is-iterable"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.6/library/fn/is-iterable"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/$.task", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.ctx", "npm:core-js@0.9.6/library/modules/$.cof", "npm:core-js@0.9.6/library/modules/$.invoke", "npm:core-js@0.9.6/library/modules/$.dom-create", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var $ = require("npm:core-js@0.9.6/library/modules/$"),
        ctx = require("npm:core-js@0.9.6/library/modules/$.ctx"),
        cof = require("npm:core-js@0.9.6/library/modules/$.cof"),
        invoke = require("npm:core-js@0.9.6/library/modules/$.invoke"),
        cel = require("npm:core-js@0.9.6/library/modules/$.dom-create"),
        global = $.g,
        isFunction = $.isFunction,
        html = $.html,
        process = global.process,
        setTask = global.setImmediate,
        clearTask = global.clearImmediate,
        postMessage = global.postMessage,
        addEventListener = global.addEventListener,
        MessageChannel = global.MessageChannel,
        counter = 0,
        queue = {},
        ONREADYSTATECHANGE = 'onreadystatechange',
        defer,
        channel,
        port;
    function run() {
      var id = +this;
      if ($.has(queue, id)) {
        var fn = queue[id];
        delete queue[id];
        fn();
      }
    }
    function listner(event) {
      run.call(event.data);
    }
    if (!isFunction(setTask) || !isFunction(clearTask)) {
      setTask = function(fn) {
        var args = [],
            i = 1;
        while (arguments.length > i)
          args.push(arguments[i++]);
        queue[++counter] = function() {
          invoke(isFunction(fn) ? fn : Function(fn), args);
        };
        defer(counter);
        return counter;
      };
      clearTask = function(id) {
        delete queue[id];
      };
      if (cof(process) == 'process') {
        defer = function(id) {
          process.nextTick(ctx(run, id, 1));
        };
      } else if (addEventListener && isFunction(postMessage) && !global.importScripts) {
        defer = function(id) {
          postMessage(id, '*');
        };
        addEventListener('message', listner, false);
      } else if (isFunction(MessageChannel)) {
        channel = new MessageChannel;
        port = channel.port2;
        channel.port1.onmessage = listner;
        defer = ctx(port.postMessage, port, 1);
      } else if (ONREADYSTATECHANGE in cel('script')) {
        defer = function(id) {
          html.appendChild(cel('script'))[ONREADYSTATECHANGE] = function() {
            html.removeChild(this);
            run.call(id);
          };
        };
      } else {
        defer = function(id) {
          setTimeout(ctx(run, id, 1), 0);
        };
      }
    }
    module.exports = {
      set: setTask,
      clear: clearTask
    };
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/shim", ["npm:core-js@0.9.6/modules/es5", "npm:core-js@0.9.6/modules/es6.symbol", "npm:core-js@0.9.6/modules/es6.object.assign", "npm:core-js@0.9.6/modules/es6.object.is", "npm:core-js@0.9.6/modules/es6.object.set-prototype-of", "npm:core-js@0.9.6/modules/es6.object.to-string", "npm:core-js@0.9.6/modules/es6.object.statics-accept-primitives", "npm:core-js@0.9.6/modules/es6.function.name", "npm:core-js@0.9.6/modules/es6.function.has-instance", "npm:core-js@0.9.6/modules/es6.number.constructor", "npm:core-js@0.9.6/modules/es6.number.statics", "npm:core-js@0.9.6/modules/es6.math", "npm:core-js@0.9.6/modules/es6.string.from-code-point", "npm:core-js@0.9.6/modules/es6.string.raw", "npm:core-js@0.9.6/modules/es6.string.iterator", "npm:core-js@0.9.6/modules/es6.string.code-point-at", "npm:core-js@0.9.6/modules/es6.string.ends-with", "npm:core-js@0.9.6/modules/es6.string.includes", "npm:core-js@0.9.6/modules/es6.string.repeat", "npm:core-js@0.9.6/modules/es6.string.starts-with", "npm:core-js@0.9.6/modules/es6.array.from", "npm:core-js@0.9.6/modules/es6.array.of", "npm:core-js@0.9.6/modules/es6.array.iterator", "npm:core-js@0.9.6/modules/es6.array.species", "npm:core-js@0.9.6/modules/es6.array.copy-within", "npm:core-js@0.9.6/modules/es6.array.fill", "npm:core-js@0.9.6/modules/es6.array.find", "npm:core-js@0.9.6/modules/es6.array.find-index", "npm:core-js@0.9.6/modules/es6.regexp", "npm:core-js@0.9.6/modules/es6.promise", "npm:core-js@0.9.6/modules/es6.map", "npm:core-js@0.9.6/modules/es6.set", "npm:core-js@0.9.6/modules/es6.weak-map", "npm:core-js@0.9.6/modules/es6.weak-set", "npm:core-js@0.9.6/modules/es6.reflect", "npm:core-js@0.9.6/modules/es7.array.includes", "npm:core-js@0.9.6/modules/es7.string.at", "npm:core-js@0.9.6/modules/es7.string.lpad", "npm:core-js@0.9.6/modules/es7.string.rpad", "npm:core-js@0.9.6/modules/es7.regexp.escape", "npm:core-js@0.9.6/modules/es7.object.get-own-property-descriptors", "npm:core-js@0.9.6/modules/es7.object.to-array", "npm:core-js@0.9.6/modules/es7.map.to-json", "npm:core-js@0.9.6/modules/es7.set.to-json", "npm:core-js@0.9.6/modules/js.array.statics", "npm:core-js@0.9.6/modules/web.timers", "npm:core-js@0.9.6/modules/web.immediate", "npm:core-js@0.9.6/modules/web.dom.iterable", "npm:core-js@0.9.6/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/modules/es5");
  require("npm:core-js@0.9.6/modules/es6.symbol");
  require("npm:core-js@0.9.6/modules/es6.object.assign");
  require("npm:core-js@0.9.6/modules/es6.object.is");
  require("npm:core-js@0.9.6/modules/es6.object.set-prototype-of");
  require("npm:core-js@0.9.6/modules/es6.object.to-string");
  require("npm:core-js@0.9.6/modules/es6.object.statics-accept-primitives");
  require("npm:core-js@0.9.6/modules/es6.function.name");
  require("npm:core-js@0.9.6/modules/es6.function.has-instance");
  require("npm:core-js@0.9.6/modules/es6.number.constructor");
  require("npm:core-js@0.9.6/modules/es6.number.statics");
  require("npm:core-js@0.9.6/modules/es6.math");
  require("npm:core-js@0.9.6/modules/es6.string.from-code-point");
  require("npm:core-js@0.9.6/modules/es6.string.raw");
  require("npm:core-js@0.9.6/modules/es6.string.iterator");
  require("npm:core-js@0.9.6/modules/es6.string.code-point-at");
  require("npm:core-js@0.9.6/modules/es6.string.ends-with");
  require("npm:core-js@0.9.6/modules/es6.string.includes");
  require("npm:core-js@0.9.6/modules/es6.string.repeat");
  require("npm:core-js@0.9.6/modules/es6.string.starts-with");
  require("npm:core-js@0.9.6/modules/es6.array.from");
  require("npm:core-js@0.9.6/modules/es6.array.of");
  require("npm:core-js@0.9.6/modules/es6.array.iterator");
  require("npm:core-js@0.9.6/modules/es6.array.species");
  require("npm:core-js@0.9.6/modules/es6.array.copy-within");
  require("npm:core-js@0.9.6/modules/es6.array.fill");
  require("npm:core-js@0.9.6/modules/es6.array.find");
  require("npm:core-js@0.9.6/modules/es6.array.find-index");
  require("npm:core-js@0.9.6/modules/es6.regexp");
  require("npm:core-js@0.9.6/modules/es6.promise");
  require("npm:core-js@0.9.6/modules/es6.map");
  require("npm:core-js@0.9.6/modules/es6.set");
  require("npm:core-js@0.9.6/modules/es6.weak-map");
  require("npm:core-js@0.9.6/modules/es6.weak-set");
  require("npm:core-js@0.9.6/modules/es6.reflect");
  require("npm:core-js@0.9.6/modules/es7.array.includes");
  require("npm:core-js@0.9.6/modules/es7.string.at");
  require("npm:core-js@0.9.6/modules/es7.string.lpad");
  require("npm:core-js@0.9.6/modules/es7.string.rpad");
  require("npm:core-js@0.9.6/modules/es7.regexp.escape");
  require("npm:core-js@0.9.6/modules/es7.object.get-own-property-descriptors");
  require("npm:core-js@0.9.6/modules/es7.object.to-array");
  require("npm:core-js@0.9.6/modules/es7.map.to-json");
  require("npm:core-js@0.9.6/modules/es7.set.to-json");
  require("npm:core-js@0.9.6/modules/js.array.statics");
  require("npm:core-js@0.9.6/modules/web.timers");
  require("npm:core-js@0.9.6/modules/web.immediate");
  require("npm:core-js@0.9.6/modules/web.dom.iterable");
  module.exports = require("npm:core-js@0.9.6/modules/$").core;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/core-js/symbol", ["npm:core-js@0.9.6/library/fn/symbol"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.6/library/fn/symbol"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-buffer@0.1.0/index", ["npm:buffer@3.2.2"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = System._nodeRequire ? System._nodeRequire('buffer') : require("npm:buffer@3.2.2");
  global.define = __define;
  return module.exports;
});

System.register("npm:stream-browserify@1.0.0/index", ["github:jspm/nodelibs-events@0.1.0", "npm:inherits@2.0.1", "npm:readable-stream@1.1.13/readable", "npm:readable-stream@1.1.13/writable", "npm:readable-stream@1.1.13/duplex", "npm:readable-stream@1.1.13/transform", "npm:readable-stream@1.1.13/passthrough"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = Stream;
  var EE = require("github:jspm/nodelibs-events@0.1.0").EventEmitter;
  var inherits = require("npm:inherits@2.0.1");
  inherits(Stream, EE);
  Stream.Readable = require("npm:readable-stream@1.1.13/readable");
  Stream.Writable = require("npm:readable-stream@1.1.13/writable");
  Stream.Duplex = require("npm:readable-stream@1.1.13/duplex");
  Stream.Transform = require("npm:readable-stream@1.1.13/transform");
  Stream.PassThrough = require("npm:readable-stream@1.1.13/passthrough");
  Stream.Stream = Stream;
  function Stream() {
    EE.call(this);
  }
  Stream.prototype.pipe = function(dest, options) {
    var source = this;
    function ondata(chunk) {
      if (dest.writable) {
        if (false === dest.write(chunk) && source.pause) {
          source.pause();
        }
      }
    }
    source.on('data', ondata);
    function ondrain() {
      if (source.readable && source.resume) {
        source.resume();
      }
    }
    dest.on('drain', ondrain);
    if (!dest._isStdio && (!options || options.end !== false)) {
      source.on('end', onend);
      source.on('close', onclose);
    }
    var didOnEnd = false;
    function onend() {
      if (didOnEnd)
        return ;
      didOnEnd = true;
      dest.end();
    }
    function onclose() {
      if (didOnEnd)
        return ;
      didOnEnd = true;
      if (typeof dest.destroy === 'function')
        dest.destroy();
    }
    function onerror(er) {
      cleanup();
      if (EE.listenerCount(this, 'error') === 0) {
        throw er;
      }
    }
    source.on('error', onerror);
    dest.on('error', onerror);
    function cleanup() {
      source.removeListener('data', ondata);
      dest.removeListener('drain', ondrain);
      source.removeListener('end', onend);
      source.removeListener('close', onclose);
      source.removeListener('error', onerror);
      dest.removeListener('error', onerror);
      source.removeListener('end', cleanup);
      source.removeListener('close', cleanup);
      dest.removeListener('close', cleanup);
    }
    source.on('end', cleanup);
    source.on('close', cleanup);
    dest.on('close', cleanup);
    dest.emit('pipe', source);
    return dest;
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-aes@1.0.0", ["npm:browserify-aes@1.0.0/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:browserify-aes@1.0.0/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:diffie-hellman@3.0.1/lib/generatePrime", ["npm:randombytes@2.0.1", "npm:bn.js@1.3.0", "npm:miller-rabin@1.1.5"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var randomBytes = require("npm:randombytes@2.0.1");
  module.exports = findPrime;
  findPrime.simpleSieve = simpleSieve;
  findPrime.fermatTest = fermatTest;
  var BN = require("npm:bn.js@1.3.0");
  var TWENTYFOUR = new BN(24);
  var MillerRabin = require("npm:miller-rabin@1.1.5");
  var millerRabin = new MillerRabin();
  var ONE = new BN(1);
  var TWO = new BN(2);
  var FIVE = new BN(5);
  var SIXTEEN = new BN(16);
  var EIGHT = new BN(8);
  var TEN = new BN(10);
  var THREE = new BN(3);
  var SEVEN = new BN(7);
  var ELEVEN = new BN(11);
  var FOUR = new BN(4);
  var TWELVE = new BN(12);
  var primes = null;
  function _getPrimes() {
    if (primes !== null)
      return primes;
    var limit = 0x100000;
    var res = [];
    res[0] = 2;
    for (var i = 1,
        k = 3; k < limit; k += 2) {
      var sqrt = Math.ceil(Math.sqrt(k));
      for (var j = 0; j < i && res[j] <= sqrt; j++)
        if (k % res[j] === 0)
          break;
      if (i !== j && res[j] <= sqrt)
        continue;
      res[i++] = k;
    }
    primes = res;
    return res;
  }
  function simpleSieve(p) {
    var primes = _getPrimes();
    for (var i = 0; i < primes.length; i++)
      if (p.modn(primes[i]) === 0) {
        if (p.cmpn(primes[i]) === 0) {
          return true;
        } else {
          return false;
        }
      }
    return true;
  }
  function fermatTest(p) {
    var red = BN.mont(p);
    return TWO.toRed(red).redPow(p.subn(1)).fromRed().cmpn(1) === 0;
  }
  function findPrime(bits, gen) {
    if (bits < 16) {
      if (gen === 2 || gen === 5) {
        return new BN([0x8c, 0x7b]);
      } else {
        return new BN([0x8c, 0x27]);
      }
    }
    gen = new BN(gen);
    var runs,
        comp;
    function generateRandom(bits) {
      runs = -1;
      var out = new BN(randomBytes(Math.ceil(bits / 8)));
      while (out.bitLength() > bits) {
        out.ishrn(1);
      }
      if (out.isEven()) {
        out.iadd(ONE);
      }
      if (!out.testn(1)) {
        out.iadd(TWO);
      }
      if (!gen.cmp(TWO)) {
        while (out.mod(TWENTYFOUR).cmp(ELEVEN)) {
          out.iadd(FOUR);
        }
        comp = {
          major: [TWENTYFOUR],
          minor: [TWELVE]
        };
      } else if (!gen.cmp(FIVE)) {
        rem = out.mod(TEN);
        while (rem.cmp(THREE)) {
          out.iadd(FOUR);
          rem = out.mod(TEN);
        }
        comp = {
          major: [FOUR, SIXTEEN],
          minor: [TWO, EIGHT]
        };
      } else {
        comp = {
          major: [FOUR],
          minor: [TWO]
        };
      }
      return out;
    }
    var num = generateRandom(bits);
    var n2 = num.shrn(1);
    while (true) {
      while (num.bitLength() > bits) {
        num = generateRandom(bits);
        n2 = num.shrn(1);
      }
      runs++;
      if (simpleSieve(n2) && simpleSieve(num) && fermatTest(n2) && fermatTest(num) && millerRabin.test(n2) && millerRabin.test(num)) {
        return num;
      }
      num.iadd(comp.major[runs % comp.major.length]);
      n2.iadd(comp.minor[runs % comp.minor.length]);
    }
  }
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-vm@0.1.0/index", ["npm:vm-browserify@0.0.4"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = System._nodeRequire ? System._nodeRequire('vm') : require("npm:vm-browserify@0.0.4");
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1/lib/elliptic", ["npm:elliptic@1.0.1/package.json!github:systemjs/plugin-json@0.1.0", "npm:elliptic@1.0.1/lib/elliptic/utils", "npm:brorand@1.0.5", "npm:elliptic@1.0.1/lib/elliptic/hmac-drbg", "npm:elliptic@1.0.1/lib/elliptic/curve/index", "npm:elliptic@1.0.1/lib/elliptic/curves", "npm:elliptic@1.0.1/lib/elliptic/ec/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var elliptic = exports;
  elliptic.version = require("npm:elliptic@1.0.1/package.json!github:systemjs/plugin-json@0.1.0").version;
  elliptic.utils = require("npm:elliptic@1.0.1/lib/elliptic/utils");
  elliptic.rand = require("npm:brorand@1.0.5");
  elliptic.hmacDRBG = require("npm:elliptic@1.0.1/lib/elliptic/hmac-drbg");
  elliptic.curve = require("npm:elliptic@1.0.1/lib/elliptic/curve/index");
  elliptic.curves = require("npm:elliptic@1.0.1/lib/elliptic/curves");
  elliptic.ec = require("npm:elliptic@1.0.1/lib/elliptic/ec/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/core-js/array/from", ["npm:core-js@0.9.6/library/fn/array/from"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.6/library/fn/array/from"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/helpers/sliced-to-array", ["npm:babel-runtime@5.2.9/core-js/is-iterable", "npm:babel-runtime@5.2.9/core-js/get-iterator"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _isIterable = require("npm:babel-runtime@5.2.9/core-js/is-iterable")["default"];
  var _getIterator = require("npm:babel-runtime@5.2.9/core-js/get-iterator")["default"];
  exports["default"] = function(arr, i) {
    if (Array.isArray(arr)) {
      return arr;
    } else if (_isIterable(Object(arr))) {
      var _arr = [];
      var _n = true;
      var _d = false;
      var _e = undefined;
      try {
        for (var _i = _getIterator(arr),
            _s; !(_n = (_s = _i.next()).done); _n = true) {
          _arr.push(_s.value);
          if (i && _arr.length === i)
            break;
        }
      } catch (err) {
        _d = true;
        _e = err;
      } finally {
        try {
          if (!_n && _i["return"])
            _i["return"]();
        } finally {
          if (_d)
            throw _e;
        }
      }
      return _arr;
    } else {
      throw new TypeError("Invalid attempt to destructure non-iterable instance");
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/modules/es6.promise", ["npm:core-js@0.9.6/library/modules/$", "npm:core-js@0.9.6/library/modules/$.ctx", "npm:core-js@0.9.6/library/modules/$.cof", "npm:core-js@0.9.6/library/modules/$.def", "npm:core-js@0.9.6/library/modules/$.assert", "npm:core-js@0.9.6/library/modules/$.for-of", "npm:core-js@0.9.6/library/modules/$.set-proto", "npm:core-js@0.9.6/library/modules/$.species", "npm:core-js@0.9.6/library/modules/$.wks", "npm:core-js@0.9.6/library/modules/$.uid", "npm:core-js@0.9.6/library/modules/$.task", "npm:core-js@0.9.6/library/modules/$.iter-detect", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var $ = require("npm:core-js@0.9.6/library/modules/$"),
        ctx = require("npm:core-js@0.9.6/library/modules/$.ctx"),
        cof = require("npm:core-js@0.9.6/library/modules/$.cof"),
        $def = require("npm:core-js@0.9.6/library/modules/$.def"),
        assert = require("npm:core-js@0.9.6/library/modules/$.assert"),
        forOf = require("npm:core-js@0.9.6/library/modules/$.for-of"),
        setProto = require("npm:core-js@0.9.6/library/modules/$.set-proto").set,
        species = require("npm:core-js@0.9.6/library/modules/$.species"),
        SPECIES = require("npm:core-js@0.9.6/library/modules/$.wks")('species'),
        RECORD = require("npm:core-js@0.9.6/library/modules/$.uid").safe('record'),
        PROMISE = 'Promise',
        global = $.g,
        process = global.process,
        asap = process && process.nextTick || require("npm:core-js@0.9.6/library/modules/$.task").set,
        P = global[PROMISE],
        isFunction = $.isFunction,
        isObject = $.isObject,
        assertFunction = assert.fn,
        assertObject = assert.obj;
    var useNative = function() {
      var test,
          works = false;
      function P2(x) {
        var self = new P(x);
        setProto(self, P2.prototype);
        return self;
      }
      try {
        works = isFunction(P) && isFunction(P.resolve) && P.resolve(test = new P(function() {})) == test;
        setProto(P2, P);
        P2.prototype = $.create(P.prototype, {constructor: {value: P2}});
        if (!(P2.resolve(5).then(function() {}) instanceof P2)) {
          works = false;
        }
      } catch (e) {
        works = false;
      }
      return works;
    }();
    function getConstructor(C) {
      var S = assertObject(C)[SPECIES];
      return S != undefined ? S : C;
    }
    function isThenable(it) {
      var then;
      if (isObject(it))
        then = it.then;
      return isFunction(then) ? then : false;
    }
    function notify(record) {
      var chain = record.c;
      if (chain.length)
        asap(function() {
          var value = record.v,
              ok = record.s == 1,
              i = 0;
          function run(react) {
            var cb = ok ? react.ok : react.fail,
                ret,
                then;
            try {
              if (cb) {
                if (!ok)
                  record.h = true;
                ret = cb === true ? value : cb(value);
                if (ret === react.P) {
                  react.rej(TypeError('Promise-chain cycle'));
                } else if (then = isThenable(ret)) {
                  then.call(ret, react.res, react.rej);
                } else
                  react.res(ret);
              } else
                react.rej(value);
            } catch (err) {
              react.rej(err);
            }
          }
          while (chain.length > i)
            run(chain[i++]);
          chain.length = 0;
        });
    }
    function isUnhandled(promise) {
      var record = promise[RECORD],
          chain = record.a || record.c,
          i = 0,
          react;
      if (record.h)
        return false;
      while (chain.length > i) {
        react = chain[i++];
        if (react.fail || !isUnhandled(react.P))
          return false;
      }
      return true;
    }
    function $reject(value) {
      var record = this,
          promise;
      if (record.d)
        return ;
      record.d = true;
      record = record.r || record;
      record.v = value;
      record.s = 2;
      record.a = record.c.slice();
      setTimeout(function() {
        asap(function() {
          if (isUnhandled(promise = record.p)) {
            if (cof(process) == 'process') {
              process.emit('unhandledRejection', value, promise);
            } else if (global.console && isFunction(console.error)) {
              console.error('Unhandled promise rejection', value);
            }
          }
          record.a = undefined;
        });
      }, 1);
      notify(record);
    }
    function $resolve(value) {
      var record = this,
          then,
          wrapper;
      if (record.d)
        return ;
      record.d = true;
      record = record.r || record;
      try {
        if (then = isThenable(value)) {
          wrapper = {
            r: record,
            d: false
          };
          then.call(value, ctx($resolve, wrapper, 1), ctx($reject, wrapper, 1));
        } else {
          record.v = value;
          record.s = 1;
          notify(record);
        }
      } catch (err) {
        $reject.call(wrapper || {
          r: record,
          d: false
        }, err);
      }
    }
    if (!useNative) {
      P = function Promise(executor) {
        assertFunction(executor);
        var record = {
          p: assert.inst(this, P, PROMISE),
          c: [],
          a: undefined,
          s: 0,
          d: false,
          v: undefined,
          h: false
        };
        $.hide(this, RECORD, record);
        try {
          executor(ctx($resolve, record, 1), ctx($reject, record, 1));
        } catch (err) {
          $reject.call(record, err);
        }
      };
      $.mix(P.prototype, {
        then: function then(onFulfilled, onRejected) {
          var S = assertObject(assertObject(this).constructor)[SPECIES];
          var react = {
            ok: isFunction(onFulfilled) ? onFulfilled : true,
            fail: isFunction(onRejected) ? onRejected : false
          };
          var promise = react.P = new (S != undefined ? S : P)(function(res, rej) {
            react.res = assertFunction(res);
            react.rej = assertFunction(rej);
          });
          var record = this[RECORD];
          record.c.push(react);
          if (record.a)
            record.a.push(react);
          record.s && notify(record);
          return promise;
        },
        'catch': function(onRejected) {
          return this.then(undefined, onRejected);
        }
      });
    }
    $def($def.G + $def.W + $def.F * !useNative, {Promise: P});
    cof.set(P, PROMISE);
    species(P);
    species($.core[PROMISE]);
    $def($def.S + $def.F * !useNative, PROMISE, {
      reject: function reject(r) {
        return new (getConstructor(this))(function(res, rej) {
          rej(r);
        });
      },
      resolve: function resolve(x) {
        return isObject(x) && RECORD in x && $.getProto(x) === this.prototype ? x : new (getConstructor(this))(function(res) {
          res(x);
        });
      }
    });
    $def($def.S + $def.F * !(useNative && require("npm:core-js@0.9.6/library/modules/$.iter-detect")(function(iter) {
      P.all(iter)['catch'](function() {});
    })), PROMISE, {
      all: function all(iterable) {
        var C = getConstructor(this),
            values = [];
        return new C(function(res, rej) {
          forOf(iterable, false, values.push, values);
          var remaining = values.length,
              results = Array(remaining);
          if (remaining)
            $.each.call(values, function(promise, index) {
              C.resolve(promise).then(function(value) {
                results[index] = value;
                --remaining || res(results);
              }, rej);
            });
          else
            res(results);
        });
      },
      race: function race(iterable) {
        var C = getConstructor(this);
        return new C(function(res, rej) {
          forOf(iterable, false, function(promise) {
            C.resolve(promise).then(res, rej);
          });
        });
      }
    });
  })(require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/regenerator/runtime", ["npm:babel-runtime@5.2.9/core-js/symbol", "npm:babel-runtime@5.2.9/core-js/symbol/iterator", "npm:babel-runtime@5.2.9/core-js/object/create", "npm:babel-runtime@5.2.9/core-js/promise"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Symbol = require("npm:babel-runtime@5.2.9/core-js/symbol")["default"];
  var _Symbol$iterator = require("npm:babel-runtime@5.2.9/core-js/symbol/iterator")["default"];
  var _Object$create = require("npm:babel-runtime@5.2.9/core-js/object/create")["default"];
  var _Promise = require("npm:babel-runtime@5.2.9/core-js/promise")["default"];
  !(function(global) {
    "use strict";
    var hasOwn = Object.prototype.hasOwnProperty;
    var undefined;
    var iteratorSymbol = typeof _Symbol === "function" && _Symbol$iterator || "@@iterator";
    var inModule = typeof module === "object";
    var runtime = global.regeneratorRuntime;
    if (runtime) {
      if (inModule) {
        module.exports = runtime;
      }
      return ;
    }
    runtime = global.regeneratorRuntime = inModule ? module.exports : {};
    function wrap(innerFn, outerFn, self, tryLocsList) {
      var generator = _Object$create((outerFn || Generator).prototype);
      generator._invoke = makeInvokeMethod(innerFn, self || null, new Context(tryLocsList || []));
      return generator;
    }
    runtime.wrap = wrap;
    function tryCatch(fn, obj, arg) {
      try {
        return {
          type: "normal",
          arg: fn.call(obj, arg)
        };
      } catch (err) {
        return {
          type: "throw",
          arg: err
        };
      }
    }
    var GenStateSuspendedStart = "suspendedStart";
    var GenStateSuspendedYield = "suspendedYield";
    var GenStateExecuting = "executing";
    var GenStateCompleted = "completed";
    var ContinueSentinel = {};
    function Generator() {}
    function GeneratorFunction() {}
    function GeneratorFunctionPrototype() {}
    var Gp = GeneratorFunctionPrototype.prototype = Generator.prototype;
    GeneratorFunction.prototype = Gp.constructor = GeneratorFunctionPrototype;
    GeneratorFunctionPrototype.constructor = GeneratorFunction;
    GeneratorFunction.displayName = "GeneratorFunction";
    runtime.isGeneratorFunction = function(genFun) {
      var ctor = typeof genFun === "function" && genFun.constructor;
      return ctor ? ctor === GeneratorFunction || (ctor.displayName || ctor.name) === "GeneratorFunction" : false;
    };
    runtime.mark = function(genFun) {
      genFun.__proto__ = GeneratorFunctionPrototype;
      genFun.prototype = _Object$create(Gp);
      return genFun;
    };
    runtime.async = function(innerFn, outerFn, self, tryLocsList) {
      return new _Promise(function(resolve, reject) {
        var generator = wrap(innerFn, outerFn, self, tryLocsList);
        var callNext = step.bind(generator, "next");
        var callThrow = step.bind(generator, "throw");
        function step(method, arg) {
          var record = tryCatch(generator[method], generator, arg);
          if (record.type === "throw") {
            reject(record.arg);
            return ;
          }
          var info = record.arg;
          if (info.done) {
            resolve(info.value);
          } else {
            _Promise.resolve(info.value).then(callNext, callThrow);
          }
        }
        callNext();
      });
    };
    function makeInvokeMethod(innerFn, self, context) {
      var state = GenStateSuspendedStart;
      return function invoke(method, arg) {
        if (state === GenStateExecuting) {
          throw new Error("Generator is already running");
        }
        if (state === GenStateCompleted) {
          return doneResult();
        }
        while (true) {
          var delegate = context.delegate;
          if (delegate) {
            if (method === "return" || method === "throw" && delegate.iterator[method] === undefined) {
              context.delegate = null;
              var returnMethod = delegate.iterator["return"];
              if (returnMethod) {
                var record = tryCatch(returnMethod, delegate.iterator, arg);
                if (record.type === "throw") {
                  method = "throw";
                  arg = record.arg;
                  continue;
                }
              }
              if (method === "return") {
                continue;
              }
            }
            var record = tryCatch(delegate.iterator[method], delegate.iterator, arg);
            if (record.type === "throw") {
              context.delegate = null;
              method = "throw";
              arg = record.arg;
              continue;
            }
            method = "next";
            arg = undefined;
            var info = record.arg;
            if (info.done) {
              context[delegate.resultName] = info.value;
              context.next = delegate.nextLoc;
            } else {
              state = GenStateSuspendedYield;
              return info;
            }
            context.delegate = null;
          }
          if (method === "next") {
            if (state === GenStateSuspendedYield) {
              context.sent = arg;
            } else {
              delete context.sent;
            }
          } else if (method === "throw") {
            if (state === GenStateSuspendedStart) {
              state = GenStateCompleted;
              throw arg;
            }
            if (context.dispatchException(arg)) {
              method = "next";
              arg = undefined;
            }
          } else if (method === "return") {
            context.abrupt("return", arg);
          }
          state = GenStateExecuting;
          var record = tryCatch(innerFn, self, context);
          if (record.type === "normal") {
            state = context.done ? GenStateCompleted : GenStateSuspendedYield;
            var info = {
              value: record.arg,
              done: context.done
            };
            if (record.arg === ContinueSentinel) {
              if (context.delegate && method === "next") {
                arg = undefined;
              }
            } else {
              return info;
            }
          } else if (record.type === "throw") {
            state = GenStateCompleted;
            method = "throw";
            arg = record.arg;
          }
        }
      };
    }
    function defineGeneratorMethod(method) {
      Gp[method] = function(arg) {
        return this._invoke(method, arg);
      };
    }
    defineGeneratorMethod("next");
    defineGeneratorMethod("throw");
    defineGeneratorMethod("return");
    Gp[iteratorSymbol] = function() {
      return this;
    };
    Gp.toString = function() {
      return "[object Generator]";
    };
    function pushTryEntry(locs) {
      var entry = {tryLoc: locs[0]};
      if (1 in locs) {
        entry.catchLoc = locs[1];
      }
      if (2 in locs) {
        entry.finallyLoc = locs[2];
        entry.afterLoc = locs[3];
      }
      this.tryEntries.push(entry);
    }
    function resetTryEntry(entry) {
      var record = entry.completion || {};
      record.type = "normal";
      delete record.arg;
      entry.completion = record;
    }
    function Context(tryLocsList) {
      this.tryEntries = [{tryLoc: "root"}];
      tryLocsList.forEach(pushTryEntry, this);
      this.reset();
    }
    runtime.keys = function(object) {
      var keys = [];
      for (var key in object) {
        keys.push(key);
      }
      keys.reverse();
      return function next() {
        while (keys.length) {
          var key = keys.pop();
          if (key in object) {
            next.value = key;
            next.done = false;
            return next;
          }
        }
        next.done = true;
        return next;
      };
    };
    function values(iterable) {
      if (iterable) {
        var iteratorMethod = iterable[iteratorSymbol];
        if (iteratorMethod) {
          return iteratorMethod.call(iterable);
        }
        if (typeof iterable.next === "function") {
          return iterable;
        }
        if (!isNaN(iterable.length)) {
          var i = -1,
              next = function next() {
                while (++i < iterable.length) {
                  if (hasOwn.call(iterable, i)) {
                    next.value = iterable[i];
                    next.done = false;
                    return next;
                  }
                }
                next.value = undefined;
                next.done = true;
                return next;
              };
          return next.next = next;
        }
      }
      return {next: doneResult};
    }
    runtime.values = values;
    function doneResult() {
      return {
        value: undefined,
        done: true
      };
    }
    Context.prototype = {
      constructor: Context,
      reset: function reset() {
        this.prev = 0;
        this.next = 0;
        this.sent = undefined;
        this.done = false;
        this.delegate = null;
        this.tryEntries.forEach(resetTryEntry);
        for (var tempIndex = 0,
            tempName; hasOwn.call(this, tempName = "t" + tempIndex) || tempIndex < 20; ++tempIndex) {
          this[tempName] = null;
        }
      },
      stop: function stop() {
        this.done = true;
        var rootEntry = this.tryEntries[0];
        var rootRecord = rootEntry.completion;
        if (rootRecord.type === "throw") {
          throw rootRecord.arg;
        }
        return this.rval;
      },
      dispatchException: function dispatchException(exception) {
        if (this.done) {
          throw exception;
        }
        var context = this;
        function handle(loc, caught) {
          record.type = "throw";
          record.arg = exception;
          context.next = loc;
          return !!caught;
        }
        for (var i = this.tryEntries.length - 1; i >= 0; --i) {
          var entry = this.tryEntries[i];
          var record = entry.completion;
          if (entry.tryLoc === "root") {
            return handle("end");
          }
          if (entry.tryLoc <= this.prev) {
            var hasCatch = hasOwn.call(entry, "catchLoc");
            var hasFinally = hasOwn.call(entry, "finallyLoc");
            if (hasCatch && hasFinally) {
              if (this.prev < entry.catchLoc) {
                return handle(entry.catchLoc, true);
              } else if (this.prev < entry.finallyLoc) {
                return handle(entry.finallyLoc);
              }
            } else if (hasCatch) {
              if (this.prev < entry.catchLoc) {
                return handle(entry.catchLoc, true);
              }
            } else if (hasFinally) {
              if (this.prev < entry.finallyLoc) {
                return handle(entry.finallyLoc);
              }
            } else {
              throw new Error("try statement without catch or finally");
            }
          }
        }
      },
      abrupt: function abrupt(type, arg) {
        for (var i = this.tryEntries.length - 1; i >= 0; --i) {
          var entry = this.tryEntries[i];
          if (entry.tryLoc <= this.prev && hasOwn.call(entry, "finallyLoc") && this.prev < entry.finallyLoc) {
            var finallyEntry = entry;
            break;
          }
        }
        if (finallyEntry && (type === "break" || type === "continue") && finallyEntry.tryLoc <= arg && arg <= finallyEntry.finallyLoc) {
          finallyEntry = null;
        }
        var record = finallyEntry ? finallyEntry.completion : {};
        record.type = type;
        record.arg = arg;
        if (finallyEntry) {
          this.next = finallyEntry.finallyLoc;
        } else {
          this.complete(record);
        }
        return ContinueSentinel;
      },
      complete: function complete(record, afterLoc) {
        if (record.type === "throw") {
          throw record.arg;
        }
        if (record.type === "break" || record.type === "continue") {
          this.next = record.arg;
        } else if (record.type === "return") {
          this.rval = record.arg;
          this.next = "end";
        } else if (record.type === "normal" && afterLoc) {
          this.next = afterLoc;
        }
        return ContinueSentinel;
      },
      finish: function finish(finallyLoc) {
        for (var i = this.tryEntries.length - 1; i >= 0; --i) {
          var entry = this.tryEntries[i];
          if (entry.finallyLoc === finallyLoc) {
            return this.complete(entry.completion, entry.afterLoc);
          }
        }
      },
      "catch": function _catch(tryLoc) {
        for (var i = this.tryEntries.length - 1; i >= 0; --i) {
          var entry = this.tryEntries[i];
          if (entry.tryLoc === tryLoc) {
            var record = entry.completion;
            if (record.type === "throw") {
              var thrown = record.arg;
              resetTryEntry(entry);
            }
            return thrown;
          }
        }
        throw new Error("illegal catch attempt");
      },
      delegateYield: function delegateYield(iterable, resultName, nextLoc) {
        this.delegate = {
          iterator: values(iterable),
          resultName: resultName,
          nextLoc: nextLoc
        };
        return ContinueSentinel;
      }
    };
  })(typeof global === "object" ? global : typeof window === "object" ? window : typeof self === "object" ? self : undefined);
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-buffer@0.1.0", ["github:jspm/nodelibs-buffer@0.1.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:jspm/nodelibs-buffer@0.1.0/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:stream-browserify@1.0.0", ["npm:stream-browserify@1.0.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:stream-browserify@1.0.0/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:diffie-hellman@3.0.1/browser", ["npm:diffie-hellman@3.0.1/lib/generatePrime", "npm:diffie-hellman@3.0.1/lib/primes.json!github:systemjs/plugin-json@0.1.0", "npm:diffie-hellman@3.0.1/lib/dh", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var generatePrime = require("npm:diffie-hellman@3.0.1/lib/generatePrime");
    var primes = require("npm:diffie-hellman@3.0.1/lib/primes.json!github:systemjs/plugin-json@0.1.0");
    var DH = require("npm:diffie-hellman@3.0.1/lib/dh");
    function getDiffieHellman(mod) {
      var prime = new Buffer(primes[mod].prime, 'hex');
      var gen = new Buffer(primes[mod].gen, 'hex');
      return new DH(prime, gen);
    }
    function createDiffieHellman(prime, enc, generator, genc) {
      if (Buffer.isBuffer(enc) || (typeof enc === 'string' && ['hex', 'binary', 'base64'].indexOf(enc) === -1)) {
        genc = generator;
        generator = enc;
        enc = undefined;
      }
      enc = enc || 'binary';
      genc = genc || 'binary';
      generator = generator || new Buffer([2]);
      if (!Buffer.isBuffer(generator)) {
        generator = new Buffer(generator, genc);
      }
      if (typeof prime === 'number') {
        return new DH(generatePrime(prime, generator), generator, true);
      }
      if (!Buffer.isBuffer(prime)) {
        prime = new Buffer(prime, enc);
      }
      return new DH(prime, generator, true);
    }
    exports.DiffieHellmanGroup = exports.createDiffieHellmanGroup = exports.getDiffieHellman = getDiffieHellman;
    exports.createDiffieHellman = exports.DiffieHellman = createDiffieHellman;
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-vm@0.1.0", ["github:jspm/nodelibs-vm@0.1.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:jspm/nodelibs-vm@0.1.0/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:elliptic@1.0.1", ["npm:elliptic@1.0.1/lib/elliptic"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:elliptic@1.0.1/lib/elliptic");
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/helpers/to-array", ["npm:babel-runtime@5.2.9/core-js/array/from"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Array$from = require("npm:babel-runtime@5.2.9/core-js/array/from")["default"];
  exports["default"] = function(arr) {
    return Array.isArray(arr) ? arr : _Array$from(arr);
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:core-js@0.9.6/library/fn/promise", ["npm:core-js@0.9.6/library/modules/es6.object.to-string", "npm:core-js@0.9.6/library/modules/es6.string.iterator", "npm:core-js@0.9.6/library/modules/web.dom.iterable", "npm:core-js@0.9.6/library/modules/es6.promise", "npm:core-js@0.9.6/library/modules/$"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  require("npm:core-js@0.9.6/library/modules/es6.object.to-string");
  require("npm:core-js@0.9.6/library/modules/es6.string.iterator");
  require("npm:core-js@0.9.6/library/modules/web.dom.iterable");
  require("npm:core-js@0.9.6/library/modules/es6.promise");
  module.exports = require("npm:core-js@0.9.6/library/modules/$").core.Promise;
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-core@5.2.9/lib/babel/polyfill", ["npm:core-js@0.9.6/shim", "npm:babel-runtime@5.2.9/regenerator/runtime"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  "use strict";
  require("npm:core-js@0.9.6/shim");
  require("npm:babel-runtime@5.2.9/regenerator/runtime");
  if (global._babelPolyfill) {
    throw new Error("only one instance of babel/polyfill is allowed");
  }
  global._babelPolyfill = true;
  global.define = __define;
  return module.exports;
});

System.register("npm:randombytes@2.0.1/browser", ["github:jspm/nodelibs-buffer@0.1.0", "github:jspm/nodelibs-process@0.1.1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer, process) {
    'use strict';
    var crypto = global.crypto || global.msCrypto;
    if (crypto && crypto.getRandomValues) {
      module.exports = randomBytes;
    } else {
      module.exports = oldBrowser;
    }
    function randomBytes(size, cb) {
      var bytes = new Buffer(size);
      crypto.getRandomValues(bytes);
      if (typeof cb === 'function') {
        return process.nextTick(function() {
          cb(null, bytes);
        });
      }
      return bytes;
    }
    function oldBrowser() {
      throw new Error('secure random number generation not supported by this browser\n' + 'use chrome, FireFox or Internet Explorer 11');
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer, require("github:jspm/nodelibs-process@0.1.1"));
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-stream@0.1.0/index", ["npm:stream-browserify@1.0.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = System._nodeRequire ? System._nodeRequire('stream') : require("npm:stream-browserify@1.0.0");
  global.define = __define;
  return module.exports;
});

System.register("npm:diffie-hellman@3.0.1", ["npm:diffie-hellman@3.0.1/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:diffie-hellman@3.0.1/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1/api", ["npm:asn1.js@1.0.4/lib/asn1", "npm:inherits@2.0.1", "github:jspm/nodelibs-vm@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var asn1 = require("npm:asn1.js@1.0.4/lib/asn1");
  var inherits = require("npm:inherits@2.0.1");
  var api = exports;
  api.define = function define(name, body) {
    return new Entity(name, body);
  };
  function Entity(name, body) {
    this.name = name;
    this.body = body;
    this.decoders = {};
    this.encoders = {};
  }
  ;
  Entity.prototype._createNamed = function createNamed(base) {
    var named;
    try {
      named = require("github:jspm/nodelibs-vm@0.1.0").runInThisContext('(function ' + this.name + '(entity) {\n' + '  this._initNamed(entity);\n' + '})');
    } catch (e) {
      named = function(entity) {
        this._initNamed(entity);
      };
    }
    inherits(named, base);
    named.prototype._initNamed = function initnamed(entity) {
      base.call(this, entity);
    };
    return new named(this);
  };
  Entity.prototype._getDecoder = function _getDecoder(enc) {
    if (!this.decoders.hasOwnProperty(enc))
      this.decoders[enc] = this._createNamed(asn1.decoders[enc]);
    return this.decoders[enc];
  };
  Entity.prototype.decode = function decode(data, enc, options) {
    return this._getDecoder(enc).decode(data, options);
  };
  Entity.prototype._getEncoder = function _getEncoder(enc) {
    if (!this.encoders.hasOwnProperty(enc))
      this.encoders[enc] = this._createNamed(asn1.encoders[enc]);
    return this.encoders[enc];
  };
  Entity.prototype.encode = function encode(data, enc, reporter) {
    return this._getEncoder(enc).encode(data, reporter);
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-runtime@5.2.9/core-js/promise", ["npm:core-js@0.9.6/library/fn/promise"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("npm:core-js@0.9.6/library/fn/promise"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

System.register("npm:babel-core@5.2.9/polyfill", ["npm:babel-core@5.2.9/lib/babel/polyfill"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  module.exports = require("npm:babel-core@5.2.9/lib/babel/polyfill");
  global.define = __define;
  return module.exports;
});

System.register("npm:randombytes@2.0.1", ["npm:randombytes@2.0.1/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:randombytes@2.0.1/browser");
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-stream@0.1.0", ["github:jspm/nodelibs-stream@0.1.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:jspm/nodelibs-stream@0.1.0/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4/lib/asn1", ["npm:bn.js@1.3.0", "npm:asn1.js@1.0.4/lib/asn1/api", "npm:asn1.js@1.0.4/lib/asn1/base/index", "npm:asn1.js@1.0.4/lib/asn1/constants/index", "npm:asn1.js@1.0.4/lib/asn1/decoders/index", "npm:asn1.js@1.0.4/lib/asn1/encoders/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var asn1 = exports;
  asn1.bignum = require("npm:bn.js@1.3.0");
  asn1.define = require("npm:asn1.js@1.0.4/lib/asn1/api").define;
  asn1.base = require("npm:asn1.js@1.0.4/lib/asn1/base/index");
  asn1.constants = require("npm:asn1.js@1.0.4/lib/asn1/constants/index");
  asn1.decoders = require("npm:asn1.js@1.0.4/lib/asn1/decoders/index");
  asn1.encoders = require("npm:asn1.js@1.0.4/lib/asn1/encoders/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:create-hash@1.1.1/browser", ["npm:inherits@2.0.1", "npm:create-hash@1.1.1/md5", "npm:ripemd160@1.0.0", "npm:sha.js@2.4.0", "github:jspm/nodelibs-stream@0.1.0", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    'use strict';
    var inherits = require("npm:inherits@2.0.1");
    var md5 = require("npm:create-hash@1.1.1/md5");
    var rmd160 = require("npm:ripemd160@1.0.0");
    var sha = require("npm:sha.js@2.4.0");
    var Transform = require("github:jspm/nodelibs-stream@0.1.0").Transform;
    function HashNoConstructor(hash) {
      Transform.call(this);
      this._hash = hash;
      this.buffers = [];
    }
    inherits(HashNoConstructor, Transform);
    HashNoConstructor.prototype._transform = function(data, _, next) {
      this.buffers.push(data);
      next();
    };
    HashNoConstructor.prototype._flush = function(next) {
      this.push(this.digest());
      next();
    };
    HashNoConstructor.prototype.update = function(data, enc) {
      if (typeof data === 'string') {
        data = new Buffer(data, enc);
      }
      this.buffers.push(data);
      return this;
    };
    HashNoConstructor.prototype.digest = function(enc) {
      var buf = Buffer.concat(this.buffers);
      var r = this._hash(buf);
      this.buffers = null;
      return enc ? r.toString(enc) : r;
    };
    function Hash(hash) {
      Transform.call(this);
      this._hash = hash;
    }
    inherits(Hash, Transform);
    Hash.prototype._transform = function(data, enc, next) {
      if (enc)
        data = new Buffer(data, enc);
      this._hash.update(data);
      next();
    };
    Hash.prototype._flush = function(next) {
      this.push(this._hash.digest());
      this._hash = null;
      next();
    };
    Hash.prototype.update = function(data, enc) {
      if (typeof data === 'string') {
        data = new Buffer(data, enc);
      }
      this._hash.update(data);
      return this;
    };
    Hash.prototype.digest = function(enc) {
      var outData = this._hash.digest();
      return enc ? outData.toString(enc) : outData;
    };
    module.exports = function createHash(alg) {
      if ('md5' === alg)
        return new HashNoConstructor(md5);
      if ('rmd160' === alg)
        return new HashNoConstructor(rmd160);
      return new Hash(sha(alg));
    };
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:asn1.js@1.0.4", ["npm:asn1.js@1.0.4/lib/asn1"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:asn1.js@1.0.4/lib/asn1");
  global.define = __define;
  return module.exports;
});

System.register("npm:create-hash@1.1.1", ["npm:create-hash@1.1.1/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:create-hash@1.1.1/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:parse-asn1@3.0.0/asn1", ["npm:asn1.js@1.0.4"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  var asn1 = require("npm:asn1.js@1.0.4");
  var RSAPrivateKey = asn1.define('RSAPrivateKey', function() {
    this.seq().obj(this.key('version').int(), this.key('modulus').int(), this.key('publicExponent').int(), this.key('privateExponent').int(), this.key('prime1').int(), this.key('prime2').int(), this.key('exponent1').int(), this.key('exponent2').int(), this.key('coefficient').int());
  });
  exports.RSAPrivateKey = RSAPrivateKey;
  var RSAPublicKey = asn1.define('RSAPublicKey', function() {
    this.seq().obj(this.key('modulus').int(), this.key('publicExponent').int());
  });
  exports.RSAPublicKey = RSAPublicKey;
  var PublicKey = asn1.define('SubjectPublicKeyInfo', function() {
    this.seq().obj(this.key('algorithm').use(AlgorithmIdentifier), this.key('subjectPublicKey').bitstr());
  });
  exports.PublicKey = PublicKey;
  var AlgorithmIdentifier = asn1.define('AlgorithmIdentifier', function() {
    this.seq().obj(this.key('algorithm').objid(), this.key('none').null_().optional(), this.key('curve').objid().optional(), this.key('params').seq().obj(this.key('p').int(), this.key('q').int(), this.key('g').int()).optional());
  });
  var PrivateKeyInfo = asn1.define('PrivateKeyInfo', function() {
    this.seq().obj(this.key('version').int(), this.key('algorithm').use(AlgorithmIdentifier), this.key('subjectPrivateKey').octstr());
  });
  exports.PrivateKey = PrivateKeyInfo;
  var EncryptedPrivateKeyInfo = asn1.define('EncryptedPrivateKeyInfo', function() {
    this.seq().obj(this.key('algorithm').seq().obj(this.key('id').objid(), this.key('decrypt').seq().obj(this.key('kde').seq().obj(this.key('id').objid(), this.key('kdeparams').seq().obj(this.key('salt').octstr(), this.key('iters').int())), this.key('cipher').seq().obj(this.key('algo').objid(), this.key('iv').octstr()))), this.key('subjectPrivateKey').octstr());
  });
  exports.EncryptedPrivateKey = EncryptedPrivateKeyInfo;
  var DSAPrivateKey = asn1.define('DSAPrivateKey', function() {
    this.seq().obj(this.key('version').int(), this.key('p').int(), this.key('q').int(), this.key('g').int(), this.key('pub_key').int(), this.key('priv_key').int());
  });
  exports.DSAPrivateKey = DSAPrivateKey;
  exports.DSAparam = asn1.define('DSAparam', function() {
    this.int();
  });
  var ECPrivateKey = asn1.define('ECPrivateKey', function() {
    this.seq().obj(this.key('version').int(), this.key('privateKey').octstr(), this.key('parameters').optional().explicit(0).use(ECParameters), this.key('publicKey').optional().explicit(1).bitstr());
  });
  exports.ECPrivateKey = ECPrivateKey;
  var ECParameters = asn1.define('ECParameters', function() {
    this.choice({namedCurve: this.objid()});
  });
  exports.signature = asn1.define('signature', function() {
    this.seq().obj(this.key('r').int(), this.key('s').int());
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:parse-asn1@3.0.0/index", ["npm:parse-asn1@3.0.0/asn1", "npm:parse-asn1@3.0.0/aesid.json!github:systemjs/plugin-json@0.1.0", "npm:parse-asn1@3.0.0/fixProc", "npm:browserify-aes@1.0.0", "npm:pbkdf2-compat@3.0.2", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var asn1 = require("npm:parse-asn1@3.0.0/asn1");
    var aesid = require("npm:parse-asn1@3.0.0/aesid.json!github:systemjs/plugin-json@0.1.0");
    var fixProc = require("npm:parse-asn1@3.0.0/fixProc");
    var ciphers = require("npm:browserify-aes@1.0.0");
    var compat = require("npm:pbkdf2-compat@3.0.2");
    module.exports = parseKeys;
    function parseKeys(buffer) {
      var password;
      if (typeof buffer === 'object' && !Buffer.isBuffer(buffer)) {
        password = buffer.passphrase;
        buffer = buffer.key;
      }
      if (typeof buffer === 'string') {
        buffer = new Buffer(buffer);
      }
      var stripped = fixProc(buffer, password);
      var type = stripped.tag;
      var data = stripped.data;
      var subtype,
          ndata;
      switch (type) {
        case 'PUBLIC KEY':
          ndata = asn1.PublicKey.decode(data, 'der');
          subtype = ndata.algorithm.algorithm.join('.');
          switch (subtype) {
            case '1.2.840.113549.1.1.1':
              return asn1.RSAPublicKey.decode(ndata.subjectPublicKey.data, 'der');
            case '1.2.840.10045.2.1':
              ndata.subjectPrivateKey = ndata.subjectPublicKey;
              return {
                type: 'ec',
                data: ndata
              };
            case '1.2.840.10040.4.1':
              ndata.algorithm.params.pub_key = asn1.DSAparam.decode(ndata.subjectPublicKey.data, 'der');
              return {
                type: 'dsa',
                data: ndata.algorithm.params
              };
            default:
              throw new Error('unknown key id ' + subtype);
          }
          throw new Error('unknown key type ' + type);
        case 'ENCRYPTED PRIVATE KEY':
          data = asn1.EncryptedPrivateKey.decode(data, 'der');
          data = decrypt(data, password);
        case 'PRIVATE KEY':
          ndata = asn1.PrivateKey.decode(data, 'der');
          subtype = ndata.algorithm.algorithm.join('.');
          switch (subtype) {
            case '1.2.840.113549.1.1.1':
              return asn1.RSAPrivateKey.decode(ndata.subjectPrivateKey, 'der');
            case '1.2.840.10045.2.1':
              return {
                curve: ndata.algorithm.curve,
                privateKey: asn1.ECPrivateKey.decode(ndata.subjectPrivateKey, 'der').privateKey
              };
            case '1.2.840.10040.4.1':
              ndata.algorithm.params.priv_key = asn1.DSAparam.decode(ndata.subjectPrivateKey, 'der');
              return {
                type: 'dsa',
                params: ndata.algorithm.params
              };
            default:
              throw new Error('unknown key id ' + subtype);
          }
          throw new Error('unknown key type ' + type);
        case 'RSA PUBLIC KEY':
          return asn1.RSAPublicKey.decode(data, 'der');
        case 'RSA PRIVATE KEY':
          return asn1.RSAPrivateKey.decode(data, 'der');
        case 'DSA PRIVATE KEY':
          return {
            type: 'dsa',
            params: asn1.DSAPrivateKey.decode(data, 'der')
          };
        case 'EC PRIVATE KEY':
          data = asn1.ECPrivateKey.decode(data, 'der');
          return {
            curve: data.parameters.value,
            privateKey: data.privateKey
          };
        default:
          throw new Error('unknown key type ' + type);
      }
    }
    parseKeys.signature = asn1.signature;
    function decrypt(data, password) {
      var salt = data.algorithm.decrypt.kde.kdeparams.salt;
      var iters = data.algorithm.decrypt.kde.kdeparams.iters;
      var algo = aesid[data.algorithm.decrypt.cipher.algo.join('.')];
      var iv = data.algorithm.decrypt.cipher.iv;
      var cipherText = data.subjectPrivateKey;
      var keylen = parseInt(algo.split('-')[1], 10) / 8;
      var key = compat.pbkdf2Sync(password, salt, iters, keylen);
      var cipher = ciphers.createDecipheriv(algo, key, iv);
      var out = [];
      out.push(cipher.update(cipherText));
      out.push(cipher.final());
      return Buffer.concat(out);
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:parse-asn1@3.0.0", ["npm:parse-asn1@3.0.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:parse-asn1@3.0.0/index");
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-sign@3.0.1/sign", ["npm:parse-asn1@3.0.0", "npm:bn.js@1.3.0", "npm:elliptic@1.0.1", "npm:browserify-rsa@2.0.0", "npm:create-hmac@1.1.3", "npm:browserify-sign@3.0.1/curves", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    var parseKeys = require("npm:parse-asn1@3.0.0");
    var BN = require("npm:bn.js@1.3.0");
    var elliptic = require("npm:elliptic@1.0.1");
    var crt = require("npm:browserify-rsa@2.0.0");
    var createHmac = require("npm:create-hmac@1.1.3");
    var curves = require("npm:browserify-sign@3.0.1/curves");
    module.exports = sign;
    function sign(hash, key, hashType, signType) {
      var priv = parseKeys(key);
      if (priv.curve) {
        if (signType !== 'ecdsa') {
          throw new Error('wrong public key type');
        }
        return ecSign(hash, priv);
      } else if (priv.type === 'dsa') {
        return dsaSign(hash, priv, hashType);
        if (signType !== 'dsa') {
          throw new Error('wrong public key type');
        }
      } else {
        if (signType !== 'rsa') {
          throw new Error('wrong public key type');
        }
      }
      var len = priv.modulus.byteLength();
      var pad = [0, 1];
      while (hash.length + pad.length + 1 < len) {
        pad.push(0xff);
      }
      pad.push(0x00);
      var i = -1;
      while (++i < hash.length) {
        pad.push(hash[i]);
      }
      var out = crt(pad, priv);
      return out;
    }
    function ecSign(hash, priv) {
      var curveId = curves[priv.curve.join('.')];
      if (!curveId)
        throw new Error('unknown curve ' + priv.curve.join('.'));
      var curve = new elliptic.ec(curveId);
      var key = curve.genKeyPair();
      key._importPrivate(priv.privateKey);
      var out = key.sign(hash);
      return new Buffer(out.toDER());
    }
    function dsaSign(hash, priv, algo) {
      var x = priv.params.priv_key;
      var p = priv.params.p;
      var q = priv.params.q;
      var montq = BN.mont(q);
      var g = priv.params.g;
      var r = new BN(0);
      var k;
      var H = bits2int(hash, q).mod(q);
      var s = false;
      var kv = getKey(x, q, hash, algo);
      while (s === false) {
        k = makeKey(q, kv, algo);
        r = makeR(g, k, p, q);
        s = k.invm(q).imul(H.add(x.mul(r))).mod(q);
        if (!s.cmpn(0)) {
          s = false;
          r = new BN(0);
        }
      }
      return toDER(r, s);
    }
    function toDER(r, s) {
      r = r.toArray();
      s = s.toArray();
      if (r[0] & 0x80)
        r = [0].concat(r);
      if (s[0] & 0x80)
        s = [0].concat(s);
      var total = r.length + s.length + 4;
      var res = [0x30, total, 0x02, r.length];
      res = res.concat(r, [0x02, s.length], s);
      return new Buffer(res);
    }
    module.exports.getKey = getKey;
    function getKey(x, q, hash, algo) {
      x = new Buffer(x.toArray());
      if (x.length < q.byteLength()) {
        var zeros = new Buffer(q.byteLength() - x.length);
        zeros.fill(0);
        x = Buffer.concat([zeros, x]);
      }
      var hlen = hash.length;
      var hbits = bits2octets(hash, q);
      var v = new Buffer(hlen);
      v.fill(1);
      var k = new Buffer(hlen);
      k.fill(0);
      k = createHmac(algo, k).update(v).update(new Buffer([0])).update(x).update(hbits).digest();
      v = createHmac(algo, k).update(v).digest();
      k = createHmac(algo, k).update(v).update(new Buffer([1])).update(x).update(hbits).digest();
      v = createHmac(algo, k).update(v).digest();
      return {
        k: k,
        v: v
      };
    }
    function bits2int(obits, q) {
      var bits = new BN(obits);
      var shift = (obits.length << 3) - q.bitLength();
      if (shift > 0) {
        bits.ishrn(shift);
      }
      return bits;
    }
    function bits2octets(bits, q) {
      bits = bits2int(bits, q);
      bits = bits.mod(q);
      var out = new Buffer(bits.toArray());
      if (out.length < q.byteLength()) {
        var zeros = new Buffer(q.byteLength() - out.length);
        zeros.fill(0);
        out = Buffer.concat([zeros, out]);
      }
      return out;
    }
    module.exports.makeKey = makeKey;
    function makeKey(q, kv, algo) {
      var t;
      var k;
      while (true) {
        t = new Buffer('');
        while (t.length * 8 < q.bitLength()) {
          kv.v = createHmac(algo, kv.k).update(kv.v).digest();
          t = Buffer.concat([t, kv.v]);
        }
        k = bits2int(t, q);
        kv.k = createHmac(algo, kv.k).update(kv.v).update(new Buffer([0])).digest();
        kv.v = createHmac(algo, kv.k).update(kv.v).digest();
        if (k.cmp(q) === -1) {
          return k;
        }
      }
    }
    function makeR(g, k, p, q) {
      return g.toRed(BN.mont(p)).redPow(k).fromRed().mod(q);
    }
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-sign@3.0.1/browser", ["npm:browserify-sign@3.0.1/sign", "npm:browserify-sign@3.0.1/verify", "github:jspm/nodelibs-stream@0.1.0", "npm:inherits@2.0.1", "npm:browserify-sign@3.0.1/algos", "npm:create-hash@1.1.1", "github:jspm/nodelibs-buffer@0.1.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    'use strict';
    var sign = require("npm:browserify-sign@3.0.1/sign");
    var verify = require("npm:browserify-sign@3.0.1/verify");
    var stream = require("github:jspm/nodelibs-stream@0.1.0");
    var inherits = require("npm:inherits@2.0.1");
    var _algos = require("npm:browserify-sign@3.0.1/algos");
    var createHash = require("npm:create-hash@1.1.1");
    var algos = {};
    Object.keys(_algos).forEach(function(key) {
      algos[key] = algos[key.toLowerCase()] = _algos[key];
    });
    exports.createSign = exports.Sign = createSign;
    function createSign(algorithm) {
      return new Sign(algorithm);
    }
    exports.createVerify = exports.Verify = createVerify;
    function createVerify(algorithm) {
      return new Verify(algorithm);
    }
    inherits(Sign, stream.Writable);
    function Sign(algorithm) {
      stream.Writable.call(this);
      var data = algos[algorithm];
      if (!data)
        throw new Error('Unknown message digest');
      this._hashType = data.hash;
      this._hash = createHash(data.hash);
      this._tag = data.id;
      this._signType = data.sign;
    }
    Sign.prototype._write = function _write(data, _, done) {
      this._hash.update(data);
      done();
    };
    Sign.prototype.update = function update(data, enc) {
      if (typeof data === 'string')
        data = new Buffer(data, enc);
      this._hash.update(data);
      return this;
    };
    Sign.prototype.sign = function signMethod(key, enc) {
      this.end();
      var hash = this._hash.digest();
      var sig = sign(Buffer.concat([this._tag, hash]), key, this._hashType, this._signType);
      if (enc) {
        sig = sig.toString(enc);
      }
      return sig;
    };
    inherits(Verify, stream.Writable);
    function Verify(algorithm) {
      stream.Writable.call(this);
      var data = algos[algorithm];
      if (!data)
        throw new Error('Unknown message digest');
      this._hash = createHash(data.hash);
      this._tag = data.id;
      this._signType = data.sign;
    }
    Verify.prototype._write = function _write(data, _, done) {
      this._hash.update(data);
      done();
    };
    Verify.prototype.update = function update(data, enc) {
      if (typeof data === 'string')
        data = new Buffer(data, enc);
      this._hash.update(data);
      return this;
    };
    Verify.prototype.verify = function verifyMethod(key, sig, enc) {
      this.end();
      var hash = this._hash.digest();
      if (typeof sig === 'string')
        sig = new Buffer(sig, enc);
      return verify(sig, Buffer.concat([this._tag, hash]), key, this._signType);
    };
  })(require("github:jspm/nodelibs-buffer@0.1.0").Buffer);
  global.define = __define;
  return module.exports;
});

System.register("npm:browserify-sign@3.0.1", ["npm:browserify-sign@3.0.1/browser"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:browserify-sign@3.0.1/browser");
  global.define = __define;
  return module.exports;
});

System.register("npm:crypto-browserify@3.9.14/index", ["npm:randombytes@2.0.1", "npm:create-hash@1.1.1", "npm:create-hmac@1.1.3", "npm:browserify-sign@3.0.1/algos", "npm:pbkdf2@3.0.4", "npm:browserify-aes@1.0.0", "npm:diffie-hellman@3.0.1", "npm:browserify-sign@3.0.1", "npm:create-ecdh@2.0.0", "npm:public-encrypt@2.0.0"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  'use strict';
  exports.randomBytes = exports.rng = exports.pseudoRandomBytes = exports.prng = require("npm:randombytes@2.0.1");
  exports.createHash = exports.Hash = require("npm:create-hash@1.1.1");
  exports.createHmac = exports.Hmac = require("npm:create-hmac@1.1.3");
  var hashes = ['sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'md5', 'rmd160'].concat(Object.keys(require("npm:browserify-sign@3.0.1/algos")));
  exports.getHashes = function() {
    return hashes;
  };
  var p = require("npm:pbkdf2@3.0.4");
  exports.pbkdf2 = p.pbkdf2;
  exports.pbkdf2Sync = p.pbkdf2Sync;
  var aes = require("npm:browserify-aes@1.0.0");
  ['Cipher', 'createCipher', 'Cipheriv', 'createCipheriv', 'Decipher', 'createDecipher', 'Decipheriv', 'createDecipheriv', 'getCiphers', 'listCiphers'].forEach(function(key) {
    exports[key] = aes[key];
  });
  var dh = require("npm:diffie-hellman@3.0.1");
  ['DiffieHellmanGroup', 'createDiffieHellmanGroup', 'getDiffieHellman', 'createDiffieHellman', 'DiffieHellman'].forEach(function(key) {
    exports[key] = dh[key];
  });
  var sign = require("npm:browserify-sign@3.0.1");
  ['createSign', 'Sign', 'createVerify', 'Verify'].forEach(function(key) {
    exports[key] = sign[key];
  });
  exports.createECDH = require("npm:create-ecdh@2.0.0");
  var publicEncrypt = require("npm:public-encrypt@2.0.0");
  ['publicEncrypt', 'privateEncrypt', 'publicDecrypt', 'privateDecrypt'].forEach(function(key) {
    exports[key] = publicEncrypt[key];
  });
  ;
  ['createCredentials'].forEach(function(name) {
    exports[name] = function() {
      throw new Error(['sorry, ' + name + ' is not implemented yet', 'we accept pull requests', 'https://github.com/crypto-browserify/crypto-browserify'].join('\n'));
    };
  });
  global.define = __define;
  return module.exports;
});

System.register("npm:crypto-browserify@3.9.14", ["npm:crypto-browserify@3.9.14/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("npm:crypto-browserify@3.9.14/index");
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-crypto@0.1.0/index", ["npm:crypto-browserify@3.9.14"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = System._nodeRequire ? System._nodeRequire('crypto') : require("npm:crypto-browserify@3.9.14");
  global.define = __define;
  return module.exports;
});

System.register("github:jspm/nodelibs-crypto@0.1.0", ["github:jspm/nodelibs-crypto@0.1.0/index"], true, function(require, exports, module) {
  var global = System.global,
      __define = global.define;
  global.define = undefined;
  module.exports = require("github:jspm/nodelibs-crypto@0.1.0/index");
  global.define = __define;
  return module.exports;
});

System.register("src/scripts/utilities", ["npm:babel-runtime@5.2.9/core-js/promise"], function (_export) {
  var _Promise, delay;

  return {
    setters: [function (_npmBabelRuntime529CoreJsPromise) {
      _Promise = _npmBabelRuntime529CoreJsPromise.default;
    }],
    execute: function () {
      "use strict";

      delay = function delay(ms) {
        return new _Promise(function (resolve, reject) {
          setTimeout(resolve, ms);
        });
      };

      _export("delay", delay);
    }
  };
});
System.register('src/scripts/sound', ['npm:babel-runtime@5.2.9/helpers/create-class', 'npm:babel-runtime@5.2.9/helpers/class-call-check', 'npm:babel-runtime@5.2.9/core-js/symbol', 'npm:babel-runtime@5.2.9/core-js/object/assign'], function (_export) {
  var _createClass, _classCallCheck, _Symbol, _Object$assign, _id, _path, _buffer, _soundManager, Sound;

  return {
    setters: [function (_npmBabelRuntime529HelpersCreateClass) {
      _createClass = _npmBabelRuntime529HelpersCreateClass['default'];
    }, function (_npmBabelRuntime529HelpersClassCallCheck) {
      _classCallCheck = _npmBabelRuntime529HelpersClassCallCheck['default'];
    }, function (_npmBabelRuntime529CoreJsSymbol) {
      _Symbol = _npmBabelRuntime529CoreJsSymbol['default'];
    }, function (_npmBabelRuntime529CoreJsObjectAssign) {
      _Object$assign = _npmBabelRuntime529CoreJsObjectAssign['default'];
    }],
    execute: function () {
      'use strict';

      _id = _Symbol('id');
      _path = _Symbol('path');
      _buffer = _Symbol('buffer');
      _soundManager = _Symbol('sound manager');

      Sound = (function () {
        function Sound(soundManager, id, path, buffer) {
          _classCallCheck(this, Sound);

          this[_soundManager] = soundManager;
          this[_id] = id;
          this[_path] = path;
          this[_buffer] = buffer;
        }

        _createClass(Sound, [{
          key: 'id',
          get: function () {
            return this[_id];
          }
        }, {
          key: 'path',
          get: function () {
            return this[_path];
          }
        }, {
          key: 'buffer',
          get: function () {
            return this[_buffer];
          }
        }, {
          key: 'play',
          value: function play(options) {
            var _options = _Object$assign({}, { loop: false }, options),
                sound = this[_soundManager].context.createBufferSource();

            sound.buffer = this[_buffer];
            sound.connect(this[_soundManager].gain);
            sound.loop = _options.loop;
            sound.noteOn(0);
          }
        }]);

        return Sound;
      })();

      _export('default', Sound);
    }
  };
});
System.register('src/scripts/sound-manager', ['npm:babel-runtime@5.2.9/helpers/create-class', 'npm:babel-runtime@5.2.9/helpers/class-call-check', 'npm:babel-runtime@5.2.9/core-js/promise', 'npm:babel-runtime@5.2.9/core-js/symbol', 'npm:babel-runtime@5.2.9/core-js/map', 'src/scripts/sound'], function (_export) {
  var _createClass, _classCallCheck, _Promise, _Symbol, _Map, Sound, fetchLocal, decodeAudioData, _audioContext, _gainNode, _volume, _sounds, _muted, SoundManager;

  return {
    setters: [function (_npmBabelRuntime529HelpersCreateClass) {
      _createClass = _npmBabelRuntime529HelpersCreateClass['default'];
    }, function (_npmBabelRuntime529HelpersClassCallCheck) {
      _classCallCheck = _npmBabelRuntime529HelpersClassCallCheck['default'];
    }, function (_npmBabelRuntime529CoreJsPromise) {
      _Promise = _npmBabelRuntime529CoreJsPromise['default'];
    }, function (_npmBabelRuntime529CoreJsSymbol) {
      _Symbol = _npmBabelRuntime529CoreJsSymbol['default'];
    }, function (_npmBabelRuntime529CoreJsMap) {
      _Map = _npmBabelRuntime529CoreJsMap['default'];
    }, function (_srcScriptsSound) {
      Sound = _srcScriptsSound['default'];
    }],
    execute: function () {
      'use strict';

      'use strict';

      fetchLocal = function fetchLocal(url) {
        return new _Promise(function (resolve, reject) {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url);
          xhr.responseType = 'arraybuffer';
          xhr.addEventListener('load', function (event) {
            resolve(xhr.response);
          });

          xhr.addEventListener('error', reject);
          xhr.send();
        });
      };

      decodeAudioData = function decodeAudioData(context, buffer) {
        return new _Promise(function (resolve, reject) {
          context.decodeAudioData(buffer, function (decodedBuffer) {
            if (!decodedBuffer) {
              throw new Error('Unable to decode buffer');
            }

            resolve(decodedBuffer);
          });
        });
      };

      _audioContext = _Symbol('audio context');
      _gainNode = _Symbol('gain node');
      _volume = _Symbol('volume');
      _sounds = _Symbol('sounds');
      _muted = _Symbol('muted');

      SoundManager = (function () {
        function SoundManager() {
          var volume = arguments[0] === undefined ? 1 : arguments[0];
          var muted = arguments[1] === undefined ? false : arguments[1];

          _classCallCheck(this, SoundManager);

          this[_audioContext] = new webkitAudioContext();
          this[_gainNode] = this[_audioContext].createGain();
          this[_gainNode].connect(this[_audioContext].destination);
          this[_gainNode].gain.value = volume;
          this[_volume] = volume;
          this[_muted] = muted;
          this[_sounds] = new _Map();
        }

        _createClass(SoundManager, [{
          key: 'load',
          value: function load(id, path) {
            var _this = this;

            var sound = fetchLocal(path).then(function (buffer) {
              return decodeAudioData(_this[_audioContext], buffer);
            }).then(function (audioBuffer) {
              return new Sound(_this, id, path, audioBuffer);
            });

            if (this[_sounds].has(id)) {
              throw new Error('Duplicate Sound Identifier');
            }

            this[_sounds].set(id, sound);

            return this;
          }
        }, {
          key: 'getSound',
          value: function getSound(id) {
            if (!this[_sounds].has(id)) {
              return _Promise.reject('Sound not found');
            }

            return this[_sounds].get(id);
          }
        }, {
          key: 'context',
          get: function () {
            return this[_audioContext];
          }
        }, {
          key: 'gain',
          get: function () {
            return this[_gainNode];
          }
        }, {
          key: 'muted',
          get: function () {
            return this[_muted];
          }
        }, {
          key: 'mute',
          value: function mute() {
            this[_gainNode].gain.value = 0;
            this[_muted] = true;
          }
        }, {
          key: 'unmute',
          value: function unmute() {
            this[_gainNode].gain.value = this[_volume];
            this[_muted] = false;
          }
        }]);

        return SoundManager;
      })();

      _export('default', SoundManager);
    }
  };
});
System.register('src/scripts/launcher', ['npm:babel-runtime@5.2.9/helpers/create-class', 'npm:babel-runtime@5.2.9/helpers/class-call-check', 'npm:babel-runtime@5.2.9/helpers/define-property', 'npm:babel-runtime@5.2.9/core-js/symbol', 'npm:babel-runtime@5.2.9/core-js/promise', 'github:jspm/nodelibs-crypto@0.1.0', 'src/scripts/utilities'], function (_export) {
  var _createClass, _classCallCheck, _defineProperty, _Symbol, _Promise, Crypto, delay, JSON_MIME_TYPE, GAME_CLIENT_API_ENDPOINT, LOGIN_ENDPOINT, LOGIN_WITH_CLAIMS_ENDPOINT, COPY_ACCOUNT_TO_TEST_ENDPOINT, REMOVE_ACCOUNT_FROM_TEST_ENDPOINT, LOGOUT_ENDPOINT, GENERATE_ENDPOINT, ACCEPT_AGREEMENT_ENDPOINT, AGREEMENT_ENDPOINT, LATEST_NEWS_ENDPOINT, PATCH_NOTES_ENDPOINT, ERROR_SESSION_MISTMATCH, Environments, _loginInfo, _testLoginInfo, _publicSessionInfo, _testSessionInfo, _publicUrl, _testUrl, _environment, ConfigurationOptions, Launcher;

  return {
    setters: [function (_npmBabelRuntime529HelpersCreateClass) {
      _createClass = _npmBabelRuntime529HelpersCreateClass['default'];
    }, function (_npmBabelRuntime529HelpersClassCallCheck) {
      _classCallCheck = _npmBabelRuntime529HelpersClassCallCheck['default'];
    }, function (_npmBabelRuntime529HelpersDefineProperty) {
      _defineProperty = _npmBabelRuntime529HelpersDefineProperty['default'];
    }, function (_npmBabelRuntime529CoreJsSymbol) {
      _Symbol = _npmBabelRuntime529CoreJsSymbol['default'];
    }, function (_npmBabelRuntime529CoreJsPromise) {
      _Promise = _npmBabelRuntime529CoreJsPromise['default'];
    }, function (_githubJspmNodelibsCrypto010) {
      Crypto = _githubJspmNodelibsCrypto010['default'];
    }, function (_srcScriptsUtilities) {
      delay = _srcScriptsUtilities.delay;
    }],
    execute: function () {
      'use strict';

      JSON_MIME_TYPE = 'application/json';
      GAME_CLIENT_API_ENDPOINT = '/api/game/client';
      LOGIN_ENDPOINT = '' + GAME_CLIENT_API_ENDPOINT + '/signin';
      LOGIN_WITH_CLAIMS_ENDPOINT = '' + GAME_CLIENT_API_ENDPOINT + '/signinwithclaims';
      COPY_ACCOUNT_TO_TEST_ENDPOINT = '/api/account/copyaccount';
      REMOVE_ACCOUNT_FROM_TEST_ENDPOINT = '/api/account/erasecopyaccount';
      LOGOUT_ENDPOINT = '' + GAME_CLIENT_API_ENDPOINT + '/signout';
      GENERATE_ENDPOINT = '' + GAME_CLIENT_API_ENDPOINT + '/generateclaims';
      ACCEPT_AGREEMENT_ENDPOINT = '' + GAME_CLIENT_API_ENDPOINT + '/loguseragreement';
      AGREEMENT_ENDPOINT = '/agreement';
      LATEST_NEWS_ENDPOINT = '' + GAME_CLIENT_API_ENDPOINT + '/getlatestnews';
      PATCH_NOTES_ENDPOINT = '' + GAME_CLIENT_API_ENDPOINT + '/getpatchnotes';
      ERROR_SESSION_MISTMATCH = 'ErrSessionMismatch';
      Environments = {
        PUBLIC: 'Public',
        TEST: 'Test'
      };
      _loginInfo = _Symbol('Login Info');
      _testLoginInfo = _Symbol('Login Info');
      _publicSessionInfo = _Symbol('Public Session Info');
      _testSessionInfo = _Symbol('Test Session Info');
      _publicUrl = _Symbol('public url');
      _testUrl = _Symbol('test url');
      _environment = _Symbol('environment');
      ConfigurationOptions = {
        MUTED: 'configuration_muted',
        USERNAME: 'configuration_username',
        DOWNLOAD_CAP: 'download_cap'
      };

      Launcher = (function () {
        function Launcher(publicUrl, testUrl) {
          _classCallCheck(this, Launcher);

          this[_publicUrl] = publicUrl;
          this[_testUrl] = testUrl;
          this[_environment] = Environments.PUBLIC;
          this[_loginInfo] = null;
          this[_publicSessionInfo] = null;
          this.deleteAllCookies();
        }

        _createClass(Launcher, [{
          key: 'start',
          value: function start() {
            window.launcher.start();
            return this;
          }
        }, {
          key: 'minimize',
          value: function minimize() {
            window.launcher.minimize();
            return this;
          }
        }, {
          key: 'show',
          value: function show() {
            window.launcher.show();
            return this;
          }
        }, {
          key: 'hide',
          value: function hide() {
            window.launcher.hide();
            return this;
          }
        }, {
          key: 'quit',
          value: function quit() {
            window.launcher.hide();
            window.launcher.quit();
            return this;
          }
        }, {
          key: 'setDraggableElement',
          value: function setDraggableElement(element) {
            var _element$getBoundingClientRect = element.getBoundingClientRect();

            var left = _element$getBoundingClientRect.left;
            var top = _element$getBoundingClientRect.top;
            var width = _element$getBoundingClientRect.width;
            var height = _element$getBoundingClientRect.height;
            var pageXOffset = window.pageXOffset;
            var pageYOffset = window.pageYOffset;
            var _window$document$documentElement = window.document.documentElement;
            var clientLeft = _window$document$documentElement.clientLeft;
            var clientTop = _window$document$documentElement.clientTop;

            window.launcher.setDraggableArea(left + pageXOffset - clientLeft, top + pageYOffset - clientTop, width, height);

            return this;
          }
        }, {
          key: 'move',
          value: function move() {
            var x = arguments[0] === undefined ? 0 : arguments[0];
            var y = arguments[1] === undefined ? 0 : arguments[1];

            window.launcher.move(x, y);
            return this;
          }
        }, {
          key: 'center',
          value: function center() {
            window.launcher.center();
            return this;
          }
        }, {
          key: 'resize',
          value: function resize(width, height) {
            window.launcher.resize(width, height);
            return this;
          }
        }, {
          key: 'openInBrowser',
          value: function openInBrowser(url) {
            window.launcher.openInBrowser(url);
            return this;
          }
        }, {
          key: 'login',
          value: function login(username, password) {
            var _this = this;

            var md5Hasher = Crypto.createHash('md5');
            md5Hasher.update(password);
            var hashedPassword = md5Hasher.digest('hex');
            var options = {
              method: 'POST',
              headers: {
                'Accept': JSON_MIME_TYPE,
                'Content-Type': JSON_MIME_TYPE
              },
              body: JSON.stringify({ username: username, password: hashedPassword })
            };

            if (this[_publicSessionInfo]) {
              var _publicSessionInfo2 = this[_publicSessionInfo];
              var sessionName = _publicSessionInfo2.sessionName;
              var sessionToken = _publicSessionInfo2.sessionToken;

              options.headers['X-' + sessionName] = sessionToken;
            }

            return fetch('' + this[_publicUrl] + '' + LOGIN_ENDPOINT, options).then(function (response) {
              return response.json();
            }).then(function (response) {
              if (!!response.success) {
                _this[_loginInfo] = response.data;

                var _response$data = response.data;
                var sessionName = _response$data.session_name;
                var sessionToken = _response$data.session_id;

                _this[_publicSessionInfo] = { sessionName: sessionName, sessionToken: sessionToken };
                return response.data;
              } else {
                if (response.code === ERROR_SESSION_MISTMATCH) {
                  return _this.deleteAllCookies().then(function () {
                    return _this.login(username, password);
                  });
                }
              }

              return _Promise.reject(response);
            });
          }
        }, {
          key: '_loginTest',
          value: function _loginTest() {
            var _this2 = this;

            var generateClaimOptions = {
              method: 'POST',
              headers: {
                'Accept': JSON_MIME_TYPE,
                'Content-Type': JSON_MIME_TYPE
              }
            };

            if (this[_publicSessionInfo]) {
              var _publicSessionInfo3 = this[_publicSessionInfo];
              var sessionName = _publicSessionInfo3.sessionName;
              var sessionToken = _publicSessionInfo3.sessionToken;

              generateClaimOptions.headers['X-' + sessionName] = sessionToken;
            }

            return fetch('' + this[_publicUrl] + '' + GENERATE_ENDPOINT, generateClaimOptions).then(function (response) {
              return response.json();
            }).then(function (response) {
              if (!!response.success) {
                return response.data;
              }

              return _Promise.reject(response);
            }).then(function (claims) {
              var signinWithClaimsOptions = {
                method: 'POST',
                headers: {
                  'Accept': JSON_MIME_TYPE,
                  'Content-Type': JSON_MIME_TYPE
                },
                body: JSON.stringify({ claims: claims })
              };

              if (_this2[_testSessionInfo]) {
                var _testSessionInfo2 = _this2[_testSessionInfo];
                var sessionName = _testSessionInfo2.sessionName;
                var sessionToken = _testSessionInfo2.sessionToken;

                signinWithClaimsOptions.headers['X-' + sessionName] = sessionToken;
              }

              return fetch('' + _this2[_testUrl] + '' + LOGIN_WITH_CLAIMS_ENDPOINT, signinWithClaimsOptions).then(function (response) {
                return response.json();
              }).then(function (response) {
                if (!!response.success) {
                  _this2[_testLoginInfo] = response.data;

                  var _response$data2 = response.data;
                  var sessionName = _response$data2.session_name;
                  var sessionToken = _response$data2.session_id;

                  _this2[_testSessionInfo] = { sessionName: sessionName, sessionToken: sessionToken };

                  return response.data;
                } else {
                  if (response.code === ERROR_SESSION_MISTMATCH) {
                    return _this2.deleteAllCookies().then(function () {
                      return _this2._loginTest();
                    });
                  }
                }

                return _Promise.reject(response);
              });
            });
          }
        }, {
          key: 'switchToEnvironment',
          value: function switchToEnvironment(environment) {
            var _this3 = this;

            if (environment === Environments.TEST) {
              return this._loginTest().then(function (response) {
                window.launcher.changeUniverse(Environments.TEST);
                _this3[_environment] = Environments.TEST;
                return response;
              });
            }

            return this._logoutTest().then(function (response) {
              window.launcher.changeUniverse(Environments.PUBLIC);
              _this3[_environment] = Environments.PUBLIC;
              return response;
            });
          }
        }, {
          key: 'getCurrentSessionId',
          value: function getCurrentSessionId() {
            if (this[_environment] === Environments.TEST) {
              return this[_testSessionInfo].sessionToken;
            }

            return this[_publicSessionInfo].sessionToken;
          }
        }, {
          key: 'getCurrentEnvironment',
          value: function getCurrentEnvironment() {
            return this[_environment];
          }
        }, {
          key: 'isLoggedIn',
          value: function isLoggedIn() {
            return this[_loginInfo] !== null;
          }
        }, {
          key: 'logout',
          value: function logout() {
            var _this4 = this;

            var _publicSessionInfo4 = this[_publicSessionInfo];
            var sessionName = _publicSessionInfo4.sessionName;
            var sessionToken = _publicSessionInfo4.sessionToken;

            var options = {
              method: 'POST',
              headers: _defineProperty({
                'Accept': JSON_MIME_TYPE,
                'Content-Type': JSON_MIME_TYPE }, 'X-' + sessionName, sessionToken)
            };

            return this._logoutTest().then(function () {
              return fetch('' + _this4[_publicUrl] + '' + LOGOUT_ENDPOINT, options);
            }).then(function (response) {
              return response.json();
            }).then(function (response) {
              if (!!response.success) {
                _this4[_loginInfo] = null;
                return response.data;
              }

              return _Promise.reject(response);
            });
          }
        }, {
          key: '_logoutTest',
          value: function _logoutTest() {
            var _this5 = this;

            if (this[_environment] !== Environments.TEST || !this[_testLoginInfo]) {
              return _Promise.resolve();
            }

            var _testSessionInfo3 = this[_testSessionInfo];
            var sessionName = _testSessionInfo3.sessionName;
            var sessionToken = _testSessionInfo3.sessionToken;

            var options = {
              method: 'POST',
              headers: _defineProperty({
                'Accept': JSON_MIME_TYPE,
                'Content-Type': JSON_MIME_TYPE }, 'X-' + sessionName, sessionToken)
            };

            return fetch('' + this[_testUrl] + '' + LOGOUT_ENDPOINT, options).then(function (response) {
              return response.json();
            }).then(function (response) {
              if (!!response.success) {
                _this5[_testLoginInfo] = null;
                return response.data;
              }

              return _Promise.reject(response);
            });
          }
        }, {
          key: 'copyAccountToTest',
          value: function copyAccountToTest() {
            var _publicSessionInfo5 = this[_publicSessionInfo];
            var sessionName = _publicSessionInfo5.sessionName;
            var sessionToken = _publicSessionInfo5.sessionToken;

            var options = {
              method: 'POST',
              headers: _defineProperty({
                'Accept': JSON_MIME_TYPE,
                'Content-Type': JSON_MIME_TYPE }, 'X-' + sessionName, sessionToken),
              body: JSON.stringify({ destination: 'ptu' })
            };

            return fetch('' + this[_publicUrl] + '' + COPY_ACCOUNT_TO_TEST_ENDPOINT, options).then(function (response) {
              return response.json();
            });
          }
        }, {
          key: 'removeAccountFromTest',
          value: function removeAccountFromTest() {
            var _publicSessionInfo6 = this[_publicSessionInfo];
            var sessionName = _publicSessionInfo6.sessionName;
            var sessionToken = _publicSessionInfo6.sessionToken;

            var options = {
              method: 'POST',
              headers: _defineProperty({
                'Accept': JSON_MIME_TYPE,
                'Content-Type': JSON_MIME_TYPE }, 'X-' + sessionName, sessionToken),
              body: JSON.stringify({ destination: 'ptu' })
            };

            return fetch('' + this[_publicUrl] + '' + REMOVE_ACCOUNT_FROM_TEST_ENDPOINT, options).then(function (response) {
              return response.json();
            });
          }
        }, {
          key: 'latestNews',
          value: function latestNews(env) {
            var options = {
              method: 'POST',
              headers: {
                'Accept': JSON_MIME_TYPE,
                'Content-Type': JSON_MIME_TYPE
              }
            };

            var url = this[_publicUrl];
            var sessionInfo = this[_publicSessionInfo];

            if (env === Environments.TEST) {
              url = this[_testUrl];
              sessionInfo = this[_testSessionInfo];
            }

            if (sessionInfo) {
              var sessionName = sessionInfo.sessionName;
              var sessionToken = sessionInfo.sessionToken;

              options.headers['X-' + sessionName] = sessionToken;
            }

            return fetch('' + url + '' + LATEST_NEWS_ENDPOINT, options).then(function (response) {
              return response.json();
            }).then(function (response) {
              if (!!response.success) {
                return response.data.resultset;
              }

              return _Promise.reject(response);
            });
          }
        }, {
          key: 'patchNotes',
          value: function patchNotes(env) {
            var options = {
              method: 'POST',
              headers: {
                'Accept': JSON_MIME_TYPE,
                'Content-Type': JSON_MIME_TYPE
              }
            };

            var url = this[_publicUrl];
            var sessionInfo = this[_publicSessionInfo];
            if (env === Environments.TEST) {
              url = this[_testUrl];
              sessionInfo = this[_testSessionInfo];
            }

            if (sessionInfo) {
              var sessionName = sessionInfo.sessionName;
              var sessionToken = sessionInfo.sessionToken;

              options.headers['X-' + sessionName] = sessionToken;
            }

            return fetch('' + url + '' + PATCH_NOTES_ENDPOINT, options).then(function (response) {
              return response.json();
            }).then(function (response) {
              if (!!response.success) {
                return response.data.resultset;
              }

              return _Promise.reject(response);
            });
          }
        }, {
          key: 'getAgreementUrl',
          value: function getAgreementUrl(id, type) {
            return '' + AGREEMENT_ENDPOINT + '/' + type + '/' + id;
          }
        }, {
          key: 'acceptAgreement',
          value: function acceptAgreement(id) {
            var _publicSessionInfo7 = this[_publicSessionInfo];
            var sessionName = _publicSessionInfo7.sessionName;
            var sessionToken = _publicSessionInfo7.sessionToken;

            var options = {
              method: 'POST',
              headers: _defineProperty({
                'Accept': JSON_MIME_TYPE,
                'Content-Type': JSON_MIME_TYPE }, 'X-' + sessionName, sessionToken),
              body: JSON.stringify({ agreement_id: id })
            };

            return fetch('' + this[_publicUrl] + '' + ACCEPT_AGREEMENT_ENDPOINT, options).then(function (response) {
              return response.json();
            }).then(function (response) {
              if (!!response.success) {
                return response.data;
              }

              return _Promise.reject(response);
            });
          }
        }, {
          key: 'getCookie',
          value: function getCookie(name) {
            return new _Promise(function (resolve) {
              return window.launcher.getCookie(name, resolve);
            });
          }
        }, {
          key: 'deleteCookie',
          value: function deleteCookie(name) {
            return new _Promise(function (resolve) {
              return window.launcher.deleteCookie(name, resolve);
            }).then(function () {
              return delay(100);
            });
          }
        }, {
          key: 'deleteAllCookies',
          value: function deleteAllCookies() {
            return new _Promise(function (resolve) {
              return window.launcher.deleteAllCookies(resolve);
            }).then(function () {
              return delay(100);
            });
          }
        }, {
          key: 'setAuthenticationToken',
          value: function setAuthenticationToken(username, token) {
            return window.launcher.setAuthenticationToken(username, token);
          }
        }, {
          key: 'pauseDownload',
          value: function pauseDownload() {
            return window.launcher.pauseDownload();
          }
        }, {
          key: 'resumeDownload',
          value: function resumeDownload() {
            return window.launcher.resumeDownload();
          }
        }, {
          key: 'setDownloadCap',
          value: function setDownloadCap(kbs) {
            return window.launcher.setDownloadCap(kbs);
          }
        }, {
          key: 'addEventListener',
          value: function addEventListener(event, callback) {
            return window.launcher.addEventListener(event, function (serializedEvent) {
              return callback(JSON.parse(serializedEvent));
            });
          }
        }, {
          key: 'removeEventListener',
          value: function removeEventListener(event, callback) {
            return window.launcher.removeEventListener(event, callback);
          }
        }, {
          key: 'launchGame',
          value: function launchGame() {
            return window.launcher.launchGame();
          }
        }, {
          key: 'checkForGameUpdate',
          value: function checkForGameUpdate() {
            return window.launcher.checkForGameUpdate();
          }
        }, {
          key: 'verify',
          value: function verify() {
            return window.launcher.verifyDownload();
          }
        }, {
          key: 'getVersion',
          value: function getVersion(callback) {
            return window.launcher.getVersion(callback);
          }
        }, {
          key: 'setConfiguration',
          value: function setConfiguration(key, value) {
            window.localStorage.setItem(key, value);
          }
        }, {
          key: 'getConfiguration',
          value: function getConfiguration(key) {
            return window.localStorage.getItem(key);
          }
        }]);

        return Launcher;
      })();

      _export('default', Launcher);

      ;

      Launcher.ConfigurationOptions = ConfigurationOptions;
    }
  };
});
System.register('src/scripts/index', ['npm:babel-runtime@5.2.9/helpers/to-array', 'npm:babel-runtime@5.2.9/helpers/sliced-to-array', 'npm:babel-runtime@5.2.9/core-js/promise', 'npm:babel-core@5.2.9/polyfill', 'github:components/jquery@2.1.3', 'src/scripts/launcher', 'src/scripts/sound-manager', 'src/scripts/utilities', 'bower:fetch@0.8.1', 'src/scripts/lib/x-select'], function (_export) {
  var _toArray, _slicedToArray, _Promise, jQuery, Launcher, SoundManager, delay, XSelectElement, PUBLIC_API_HOST, TEST_API_HOST, AGREEMENT_ACCEPT, AGREEMENT_CANCEL, launcher, soundManager, showLoginError, hideLoginError, showFatalError, hideFatalError, hideInfoBox, showInfoBox, promisifiedIframe, showUserAgreement, showUserAgreements, formatBytes, updateDownloadProgress, resetDownloadProgress, updatePatcherStatus, getNewsAndPatchNotes;

  return {
    setters: [function (_npmBabelRuntime529HelpersToArray) {
      _toArray = _npmBabelRuntime529HelpersToArray['default'];
    }, function (_npmBabelRuntime529HelpersSlicedToArray) {
      _slicedToArray = _npmBabelRuntime529HelpersSlicedToArray['default'];
    }, function (_npmBabelRuntime529CoreJsPromise) {
      _Promise = _npmBabelRuntime529CoreJsPromise['default'];
    }, function (_npmBabelCore529Polyfill) {}, function (_githubComponentsJquery213) {
      jQuery = _githubComponentsJquery213['default'];
    }, function (_srcScriptsLauncher) {
      Launcher = _srcScriptsLauncher['default'];
    }, function (_srcScriptsSoundManager) {
      SoundManager = _srcScriptsSoundManager['default'];
    }, function (_srcScriptsUtilities) {
      delay = _srcScriptsUtilities.delay;
    }, function (_bowerFetch081) {}, function (_srcScriptsLibXSelect) {
      XSelectElement = _srcScriptsLibXSelect['default'];
    }],
    execute: function () {
      'use strict';

      PUBLIC_API_HOST = 'https://robertsspaceindustries.com';
      TEST_API_HOST = 'https://ptu.cloudimperiumgames.com';
      AGREEMENT_ACCEPT = 'accept';
      AGREEMENT_CANCEL = 'cancel';
      launcher = new Launcher(PUBLIC_API_HOST, TEST_API_HOST);
      soundManager = new SoundManager(0.5);

      soundManager.load('open', 'audio/phazein.wav').load('login', 'audio/website_ui_savesettings.wav').load('error', 'audio/website_ui_rejection.wav').load('music', 'audio/music_launcher.ogg');

      showLoginError = function showLoginError(errorMessage) {
        var errorNode = jQuery('#login .error');

        errorNode.empty().html(errorMessage);
        errorNode.css('opacity', 1);
      };

      hideLoginError = function hideLoginError() {
        var errorNode = jQuery('#login .error');

        errorNode.css('opacity', 0);
        setTimeout(function () {
          return errorNode.empty();
        }, 125);
      };

      showFatalError = function showFatalError(errorMessage) {
        var title = arguments[1] === undefined ? 'Fatal Error' : arguments[1];

        var errorNode = jQuery('#fatal-error'),
            titleNode = errorNode.find('h1'),
            messageNode = errorNode.find('p');

        titleNode.empty().html(title);
        messageNode.empty().html(errorMessage);
        $('#launcher').addClass('modal');
        errorNode.show();
        errorNode.css('opacity', 1);
      };

      hideFatalError = function hideFatalError() {
        var errorNode = jQuery('#fatal-error'),
            titleNode = errorNode.find('h1'),
            messageNode = errorNode.find('p');

        $('#launcher').removeClass('modal');
        errorNode.hide();
        errorNode.css('opacity', 0);
        setTimeout(function () {
          messageNode.empty();titleNode.empty();
        }, 125);
      };

      jQuery(document).on('click', '.close-fatal-error', function () {
        hideFatalError();
      });

      hideInfoBox = function hideInfoBox() {
        var infoBoxNode = jQuery('#info-box-modal'),
            titleNode = infoBoxNode.find('h1'),
            messageNode = infoBoxNode.find('p');

        $('#launcher').removeClass('modal');
        infoBoxNode.hide();
        infoBoxNode.css('opacity', 0);
        setTimeout(function () {
          messageNode.empty();titleNode.empty();
        }, 125);
      };

      showInfoBox = function showInfoBox(title, message, buttons) {
        var infoBoxNode = jQuery('#info-box-modal'),
            titleNode = infoBoxNode.find('h1'),
            messageNode = infoBoxNode.find('p'),
            infoBoxOptions = infoBoxNode.find('.info-box-options'),
            infoBoxButtons = infoBoxOptions.find('a');

        return new _Promise(function (resolve, reject) {
          infoBoxButtons.each(function () {
            var button = $(this);

            if (buttons.indexOf(button.attr('data-type')) !== -1) {
              button.show();
            } else {
              button.hide();
            }
          });

          infoBoxOptions.one('click', 'a', function () {
            var type = $(this).attr('data-type');

            event.preventDefault();
            hideInfoBox();
            resolve(type);
          });

          titleNode.empty().html(title);
          messageNode.empty().html(message);
          $('#launcher').addClass('modal');
          infoBoxNode.show();
          infoBoxNode.css('opacity', 1);
        });
      };

      jQuery(document).on('click', '.close-info-box', function () {
        hideInfoBox();
      });

      promisifiedIframe = function promisifiedIframe(url, targetNode) {
        return new _Promise(function (resolve, reject) {
          var iframe = jQuery('<iframe></iframe>');

          iframe.on('load', function () {
            return resolve(iframe[0]);
          });
          iframe.on('error', reject);
          iframe.prop('src', url);
          jQuery(targetNode).empty().append(iframe);
        });
      };

      showUserAgreement = function showUserAgreement(id, type) {
        var agreementUrl = '' + PUBLIC_API_HOST + '' + launcher.getAgreementUrl(id, type);
        var agreement = jQuery('#agreement');
        var agreementForm = agreement.find('form');
        var launcherNode = jQuery('#launcher');

        return promisifiedIframe(agreementUrl, agreement.find('.wrapper')[0]).then(function (iframe) {
          launcherNode.addClass('modal');
          return delay(125);
        }).then(function () {
          return new _Promise(function (resolve, reject) {
            agreementForm.one('submit', function (event) {
              event.preventDefault();
              var result = agreementForm.data('value');

              agreementForm.data('value', null);
              agreement.removeClass('display');
              launcherNode.removeClass('modal');

              if (result === AGREEMENT_ACCEPT) {
                resolve(result);
              } else {
                reject(result);
              }
            });

            agreement.addClass('display');
          });
        }).then(function () {
          return launcher.acceptAgreement(id);
        });
      };

      showUserAgreements = function showUserAgreements(_ref) {
        var _ref2 = _toArray(_ref);

        var agreement = _ref2[0];

        var others = _ref2.slice(1);

        if (!agreement) {
          return _Promise.resolve([]);
        }

        var type = agreement.type;
        var id = agreement.id;

        return showUserAgreement(id, type).then(function () {
          return showUserAgreements(others);
        });
      };

      formatBytes = function formatBytes(bytes) {
        var KILOBYTE = 1024;
        var MEGABYTE = KILOBYTE * 1024;
        var GIGABYTE = MEGABYTE * 1024;
        var result = '';

        var gigabytes = Math.floor(bytes / GIGABYTE);
        var megabytes = Math.floor(bytes % GIGABYTE / MEGABYTE);
        var kilobytes = Math.floor(bytes % GIGABYTE % MEGABYTE / KILOBYTE);
        var leftBytes = Math.floor(bytes % GIGABYTE % MEGABYTE % KILOBYTE);

        if (gigabytes > 0) {
          var hundredsOfGigabyte = Math.floor(megabytes / 100);
          return '' + gigabytes + '.' + hundredsOfGigabyte + 'GB';
        } else if (megabytes > 0) {
          var hundredsOfMegabyte = Math.floor(kilobytes / 100);
          return '' + megabytes + '.' + hundredsOfMegabyte + 'MB';
        } else {
          var tenthsOfKilobyte = Math.floor(leftBytes / 10);
          return '' + kilobytes + '.' + tenthsOfKilobyte + 'KB';
        }
      };

      updateDownloadProgress = function updateDownloadProgress(status, total, loaded, uploadRate, downloadRate, peers, progress) {
        var gameCommandsNode = $('#news-and-launch .game-commands');
        var downloadProgressNode = gameCommandsNode.find('.download-progress');
        var progressNode = downloadProgressNode.find('progress');
        var estimatedTimeNode = downloadProgressNode.find('.estimated-time');
        var bytesLeftNode = downloadProgressNode.find('.bytes-left');
        var downloadRateNode = downloadProgressNode.find('.download-speed');
        var uploadRateNode = downloadProgressNode.find('.upload-speed');
        var peersNode = downloadProgressNode.find('.peers');
        var launcherOptionsNode = gameCommandsNode.find('.launch-options');

        if (status === 'Downloading' || status == 'Verifying') {
          (function () {
            var timeLeft = (total - loaded) / downloadRate;
            var formatedTimeLeft = undefined;

            downloadProgressNode.addClass('downloading');
            downloadProgressNode.prop('hidden', false);
            launcherOptionsNode.prop('hidden', true);

            if (isFinite(timeLeft)) {
              if (timeLeft < 60) {
                formatedTimeLeft = '<1m';
              } else if (timeLeft < 60 * 60) {
                formatedTimeLeft = Math.floor(timeLeft / 60) + 'm';
              } else if (timeLeft < 60 * 60 * 24) {
                var hours = Math.floor(timeLeft / (60 * 60));
                var minutes = Math.floor(timeLeft % (60 * 60) / 60);
                formatedTimeLeft = '' + hours + 'h' + minutes + 'm';
              } else {
                var days = Math.floor(timeLeft / (60 * 60 * 24));
                var hours = Math.floor(timeLeft / (60 * 60 * 24) % (60 * 60));
                var minutes = Math.floor(timeLeft % (60 * 60) / 60);
                formatedTimeLeft = '' + days + 'd' + hours + 'h' + minutes + 'm';
              }
            } else {
              formatedTimeLeft = '--';
            }

            requestAnimationFrame(function () {
              progressNode.val((loaded / total * 100).toFixed(3));
              estimatedTimeNode.html(formatedTimeLeft);
              if (status == 'Verifying') {
                bytesLeftNode.html('计算中...');
              } else {
                bytesLeftNode.html(formatBytes(total - loaded));
              }
              downloadRateNode.html(formatBytes(downloadRate) + '/s');
              //uploadRateNode.html(formatBytes(uploadRate) + '/s');
              //peersNode.html(peers);
            });
          })();
        } else if (status === 'Checking Download') {
          downloadProgressNode.removeClass('downloading');
          downloadProgressNode.prop('hidden', false);
          launcherOptionsNode.prop('hidden', true);
          requestAnimationFrame(function () {
            progressNode.val('--');
            estimatedTimeNode.html('--');
            bytesLeftNode.html('--');
            downloadRateNode.html('--');
            //uploadRateNode.html('--');
            //peersNode.html('--');
          });
        } else {
          requestAnimationFrame(function () {
            progressNode.val(0);
            estimatedTimeNode.html('');
            bytesLeftNode.html('');
            downloadRateNode.html('');
            //uploadRateNode.html('');
            //peersNode.html('');
          });
        }
      };

      resetDownloadProgress = function resetDownloadProgress() {
        var gameCommandsNode = $('#news-and-launch .game-commands');
        var downloadProgressNode = gameCommandsNode.find('.download-progress');
        var progressNode = downloadProgressNode.find('progress');
        var estimatedTimeNode = downloadProgressNode.find('.estimated-time');
        var bytesLeftNode = downloadProgressNode.find('.bytes-left');
        var downloadRateNode = downloadProgressNode.find('.download-speed');
        var uploadRateNode = downloadProgressNode.find('.upload-speed');
        var peersNode = downloadProgressNode.find('.peers');
        var launcherOptionsNode = gameCommandsNode.find('.launch-options');

        requestAnimationFrame(function () {
          progressNode.val(0);
          estimatedTimeNode.html('--');
          bytesLeftNode.html('--');
          downloadRateNode.html('--');
          //uploadRateNode.html('--');
          //peersNode.html('--');
        });
      };

      updatePatcherStatus = function updatePatcherStatus(status) {
        var gameCommandsNode = $('#news-and-launch .game-commands');
        var downloadStatusNode = gameCommandsNode.find('h1');

        var statusToDisplay = 'Unknown';

        if (status === 'Downloading' || status === 'Checking Download') {
          statusToDisplay = '更新中';
        } else if (status === 'Ready') {
          statusToDisplay = '启动就绪';
          var launcherOptionsNode = gameCommandsNode.find('.launch-options');
          var downloadProgressNode = gameCommandsNode.find('.download-progress');
          downloadProgressNode.removeClass('downloading');
          downloadProgressNode.prop('hidden', true);
          launcherOptionsNode.prop('hidden', false);
        } else if (status === 'Pause') {
          statusToDisplay = '暂停';
          resetDownloadProgress();
        }

        downloadStatusNode.text(statusToDisplay);
      };

      getNewsAndPatchNotes = function getNewsAndPatchNotes(env) {
        return _Promise.all([launcher.latestNews(env), launcher.patchNotes(env)]).then(function (_ref3) {
          var _ref32 = _slicedToArray(_ref3, 2);

          var news = _ref32[0];
          var _ref32$1 = _ref32[1];
          _ref32$1 = _ref32$1 === undefined ? [] : _ref32$1;

          var _ref32$12 = _slicedToArray(_ref32$1, 1);

          var notes = _ref32$12[0];

          var newsTemplate = $('#comm-link-template').html();
          var newTemplates = news.map(function (_ref4) {
            var title = _ref4.title;
            var url = _ref4.url;
            var publish_start = _ref4.publish_start;
            var excerpt = _ref4.excerpt;

            return newsTemplate.replace('{title}', title || 'Unknown').replace('{url}', url || '#').replace('{time}', publish_start || 'Unknown').replace('{summary}', excerpt || 'Unknown');
          });

          var time = 'Unknown';
          if (notes.publish_start) {
            var publishStart = new Date(notes.publish_start);
            time = [publishStart.getMonth() + 1, publishStart.getDate(), publishStart.getFullYear()].join(' / ');
          }
          var patchNotesTemplate = $('#patch-notes-template').html().replace('{title}', notes.title || 'Unknown').replace('{url}', notes.url || '#').replace('{time}', time).replace('{notes}', notes.body || 'Unknown');

          $('#comm-links ul').html($.parseHTML('<li>' + newTemplates.join('</li><li>') + '</li>'));
          $('#patch-notes').html($.parseHTML(patchNotesTemplate));
        });
      };

      jQuery(function ($) {

        launcher.resize(1100, 545).center().show();

        delay(750).then(function () {
          return launcher.setDraggableElement($('[data-draggable-area]')[0]);
        });

        var isMuted = launcher.getConfiguration(Launcher.ConfigurationOptions.MUTED) === '1';

        if (isMuted) {
          soundManager.mute();
          $('.mute').addClass('muted');
        }

        $('.copyright .year').text(new Date().getFullYear());

        launcher.getVersion(function (version) {
          $('.launcher-version .number').text(version);
        });

        new XSelectElement($('.settings-download-limit')[0]);

        $('.access-circles').animate({ opacity: 1 }, 1000);
        $('#login').animate({ opacity: 1 }, 1000).promise().done(function () {
          soundManager.getSound('open').then(function (sound) {
            return sound.play();
          });

          var usernameField = $('#login-username');
          var passwordField = $('#login-password');
          var username = launcher.getConfiguration(Launcher.ConfigurationOptions.USERNAME) || '';

          if (username.length > 0) {
            usernameField.val(username);
            setTimeout(function () {
              passwordField.focus();
            }, 25);
          } else {
            usernameField.focus();
          }
        });

        launcher.addEventListener('error', function (event) {
          showFatalError(event.error, event.type);
        });

        launcher.addEventListener('download-progress', function (event) {
          updateDownloadProgress(event.state, event.totalSize, event.downloadedSoFar, event.uploadRate, event.downloadRate, event.peers, event.progress);
        });

        launcher.addEventListener('download-start', function (event) {
          console.log('Download starting', event);
          if (event && event.version) {
            $('.game-version span').text(event.version);
          }
        });

        launcher.addEventListener('game-update-available', function (event) {
          console.log('Update Available', event);
          if (event && event.version) {
            $('.game-version span').text(event.version);
          }
          launcher.resumeDownload();
        });

        launcher.addEventListener('patcher-state-change', function (event) {
          console.log('Patcher State Change', event);
          if (event && event.state === 'Ready' && event.version) {
            $('.game-version span').text(event.version);
          }
          updatePatcherStatus(event.state);
        });

        $(document.body).on('click', '.mute', function (event) {
          var element = $(this);

          event.preventDefault();

          if (element.hasClass('muted')) {
            soundManager.unmute();
            launcher.setConfiguration(Launcher.ConfigurationOptions.MUTED, 0);
            element.removeClass('muted');
          } else {
            soundManager.mute();
            launcher.setConfiguration(Launcher.ConfigurationOptions.MUTED, 1);
            element.addClass('muted');
          }
        });

        $(document.body).on('click', '[data-command-minimize]', function (event) {
          event.preventDefault();
          launcher.minimize();
        });

        $(document.body).on('click', '[data-command-quit]', function (event) {
          event.preventDefault();
          launcher.quit();
        });

        $(document.body).on('click', 'a[data-external]', function (event) {
          event.preventDefault();
          launcher.openInBrowser(this.href);
        });

        $(document.body).on('click', '.settings-container .settings', function (event) {
          event.preventDefault();

          $('.settings-container').toggleClass('open');
        });

        $(document.body).on('click', '.settings-copy-account', function (event) {
          event.preventDefault();
          $('.settings-container').removeClass('open');
          showInfoBox('Copy to PTU', 'Are you sure you want to copy your LIVE account to the PTU? If a PTU account already exists, it will be overwritten.', ['YES', 'NO']).then(function (answer) {
            if (answer === 'YES') {
              return launcher.copyAccountToTest();
            }

            return _Promise.resolve();
          });
        });

        $(document.body).on('click', '.settings-remove-account', function (event) {
          event.preventDefault();
          $('.settings-container').removeClass('open');
          showInfoBox('Remove account from PTU', 'Are you sure you want to remove your PTU account?', ['YES', 'NO']).then(function (answer) {
            if (answer === 'YES') {
              return launcher.removeAccountFromTest();
            }

            return _Promise.resolve();
          });
        });

        $(document.body).on('click', '.settings-verify', function (event) {
          event.preventDefault();
          launcher.verify();
          $('.settings-container').removeClass('open');
        });

        var environmentSwitcher = $('#environment-switcher');
        environmentSwitcher.on('change', '[type="radio"]', function (event) {
          var environment = this.value;

          if (environment === 'Test') {
            environmentSwitcher.addClass('mode-test').removeClass('mode-public');
            delay(125).then(function () {
              environmentSwitcher.addClass('loading');
              return launcher.switchToEnvironment(environment);
            }).then(function () {
              $('body').addClass('ptu');
              getNewsAndPatchNotes(environment);
              launcher.setAuthenticationToken(launcher.getConfiguration(Launcher.ConfigurationOptions.USERNAME), launcher.getCurrentSessionId());
              environmentSwitcher.removeClass('loading');
            })['catch'](function (error) {
              environmentSwitcher.removeClass('mode-test loading').addClass('mode-public');
              $('#environment-public').prop('checked', true);
              if (error.code && error.code === 'HeapUnrecognizedAccountException') {
                showInfoBox('Warning', 'You need to copy your LIVE account to the PTU before you can use it', ['OK']);
              }
              console.log(error);
            });
          } else {
            environmentSwitcher.removeClass('mode-test').addClass('mode-public loading');
            launcher.switchToEnvironment(environment).then(function () {
              $('body').removeClass('ptu');
              getNewsAndPatchNotes(environment);
              launcher.setAuthenticationToken(launcher.getConfiguration(Launcher.ConfigurationOptions.USERNAME), launcher.getCurrentSessionId());
              environmentSwitcher.removeClass('loading');
            });
          }
        });

        $(document.body).on('click', function (event) {
          var settingsContainer = $('.settings-container');

          if ($(event.target).closest('.settings-container').length === 0) {
            if (settingsContainer.hasClass('open')) {
              settingsContainer.removeClass('open');
            }
          }
        });

        $(document.body).on('submit', '.settings-dropdown', function (event) {
          var form = $(this);

          event.preventDefault();

          launcher.setDownloadCap(parseInt(form.find('.settings-download-limit').val(), 10));
          $('.settings-container').removeClass('open');
        });

        $('#login').on('click', '.error a', function (event) {
          event.preventDefault();
          launcher.openInBrowser(this.href);
        });

        $(document.body).on('click', '#launch-game', function (event) {
          event.preventDefault();
          $('.mute').addClass('muted');
          soundManager.mute();
          launcher.launchGame();
        });

        $(document.body).on('click', '.pause', function (event) {
          var element = $(this);

          event.preventDefault();

          if (element.hasClass('paused')) {
            launcher.resumeDownload();
            element.removeClass('paused');
          } else {
            launcher.pauseDownload();
            element.addClass('paused');
          }
        });

        var loginFields = $('#login-username, #login-password');

        loginFields.on('focusin focusout', function (event) {
          var element = $(this),
              closestListItem = element.closest('.username, .password');

          if (event.type === 'focusin') {
            closestListItem.addClass('js-highlight');
          } else {
            if (!element.val().length) {
              closestListItem.removeClass('js-highlight');
            }
          }
        });

        $('#login').on('submit', 'form', function (event) {
          var username = $('#login-username');
          var password = $('#login-password');
          var loginNode = $('#login');
          var stripsNode = $('#background-strips');
          var loginOverlayNode = $('#login-overlay');

          event.preventDefault();

          hideLoginError();
          loginNode.addClass('sending');
          recordstrips.activate();
          launcher.login(username.val(), password.val()).then(function (_ref5) {
            var agreements = _ref5.agreements;
            var session_id = _ref5.session_id;
            var envs = _ref5.envs;

            launcher.start();
            launcher.setConfiguration(Launcher.ConfigurationOptions.USERNAME, username.val());

            soundManager.getSound('login').then(function (sound) {
              return sound.play();
            });
            setTimeout(function () {
              soundManager.getSound('music').then(function (sound) {
                return sound.play({ loop: true });
              });
            }, 1000);
            launcher.setAuthenticationToken(username.val(), session_id);
            loginNode.removeClass('sending');
            recordstrips.deactivate();
            password.val('');
            return _Promise.resolve(loginNode.fadeOut('slow').promise()).then(function () {
              var downloadCap = launcher.getConfiguration(Launcher.ConfigurationOptions.DOWNLOAD_CAP);

              if (downloadCap) {
                launcher.setDownloadCap(parseInt(downloadCap, 10));
              }

              loginOverlayNode.addClass('logged-in');
              return delay(2500);
            }).then(function () {
              return showUserAgreements(agreements);
            }).then(function () {
              $('#login').prop('hidden', true);

              $('.settings-container').fadeIn('fast');

              if ('ptu' in envs) {
                $('#environment-switcher').fadeIn('slow');
                $('.settings-ptu .ptu-version .number').text(envs.ptu.version_str);
                $('.settings-dropdown .settings-ptu').show();
              }

              $('#news-and-launch').prop('hidden', false);
            })['catch'](function (error) {
              if (error === AGREEMENT_CANCEL) {
                launcher.logout();
                loginOverlayNode.removeClass('logged-in');
                return _Promise.resolve(loginNode.fadeIn('slow').promise());
              }

              throw error;
            });
          })['catch'](function (error) {
            console.log(error);
            soundManager.getSound('error').then(function (sound) {
              return sound.play();
            });
            var code = error.code;
            var msg = error.msg;

            recordstrips.deactivate();
            loginNode.removeClass('sending');
            loginOverlayNode.removeClass('logged-in');
            showLoginError(msg ? msg : 'An unknown error occurred');
            return true;
          });
        });

        $('#agreement .actions form button').on('click', function (event) {
          var form = $('#agreement .actions form');

          form.data('value', $(event.currentTarget).data('value'));
        });

        $('#login-username').focus();

        getNewsAndPatchNotes('Public');

        var newsAndPatchNotes = $('.news-and-patch-notes');

        newsAndPatchNotes.on('click', 'header a', function (event) {
          var element = $(this);
          var sectionClass = element.attr('href');

          event.preventDefault();

          if (!element.hasClass('active')) {
            element.closest('ul').find('a.active').removeClass('active');
            element.addClass('active');

            newsAndPatchNotes.find('> .content > section').hide();
            $(sectionClass).show();
          }
        });

        var recordstrips = {
          elem: $('#background-strips'),

          children: [$('#background-strips .strip:nth-child(1)'), $('#background-strips .strip:nth-child(2)'), $('#background-strips .strip:nth-child(3)')],

          currStrip: 2,

          getNextStrip: function getNextStrip() {
            if (++this.currStrip > 2) this.currStrip = 0;
            return this.currStrip;
          },

          activate: function activate() {
            this.timer = setInterval($.proxy(this.move, this), 200);
            this.elem.fadeIn(700);
          },

          move: function move() {
            this.children[this.getNextStrip()].stop().animate({
              'background-position-x': parseInt(this.children[this.currStrip].css('background-position-x')) + (Math.floor(Math.random() * 3000) + -3000) * (Math.floor(Math.random() * 2) + 0 == 1 ? 1 : -1),
              opacity: (Math.floor(Math.random() * 9) + 1) / 10
            }, Math.floor(Math.random() * 300) + 200, 'linear' /*'easeInOutCirc' */);
          },

          deactivate: function deactivate() {
            var that = this;
            this.elem.fadeOut(700, function () {
              clearTimeout(that.timer);
            });
          }
        };
      });
    }
  };
});
(function() {
  var loader = System;
  if (typeof indexOf == 'undefined')
    indexOf = Array.prototype.indexOf;

  function readGlobalProperty(p, value) {
    var pParts = p.split('.');
    while (pParts.length)
      value = value[pParts.shift()];
    return value;
  }

  var ignoredGlobalProps = ['sessionStorage', 'localStorage', 'clipboardData', 'frames', 'external'];

  var hasOwnProperty = loader.global.hasOwnProperty;

  function iterateGlobals(callback) {
    if (Object.keys)
      Object.keys(loader.global).forEach(callback);
    else
      for (var g in loader.global) {
        if (!hasOwnProperty.call(loader.global, g))
          continue;
        callback(g);
      }
  }

  function forEachGlobal(callback) {
    iterateGlobals(function(globalName) {
      if (indexOf.call(ignoredGlobalProps, globalName) != -1)
        return;
      try {
        var value = loader.global[globalName];
      }
      catch(e) {
        ignoredGlobalProps.push(globalName);
      }
      callback(globalName, value);
    });
  }

  var moduleGlobals = {};

  var globalSnapshot;

  loader.set('@@global-helpers', loader.newModule({
    prepareGlobal: function(moduleName, deps) {
      // first, we add all the dependency modules to the global
      for (var i = 0; i < deps.length; i++) {
        var moduleGlobal = moduleGlobals[deps[i]];
        if (moduleGlobal)
          for (var m in moduleGlobal)
            loader.global[m] = moduleGlobal[m];
      }

      // now store a complete copy of the global object
      // in order to detect changes
      globalSnapshot = {};
      
      forEachGlobal(function(name, value) {
        globalSnapshot[name] = value;
      });
    },
    retrieveGlobal: function(moduleName, exportName, init) {
      var singleGlobal;
      var multipleExports;
      var exports = {};

      // run init
      if (init)
        singleGlobal = init.call(loader.global);

      // check for global changes, creating the globalObject for the module
      // if many globals, then a module object for those is created
      // if one global, then that is the module directly
      else if (exportName) {
        var firstPart = exportName.split('.')[0];
        singleGlobal = readGlobalProperty(exportName, loader.global);
        exports[firstPart] = loader.global[firstPart];
      }

      else {
        forEachGlobal(function(name, value) {
          if (globalSnapshot[name] === value)
            return;
          if (typeof value === 'undefined')
            return;
          exports[name] = value;
          if (typeof singleGlobal !== 'undefined') {
            if (!multipleExports && singleGlobal !== value)
              multipleExports = true;
          }
          else {
            singleGlobal = value;
          }
        });
      }

      moduleGlobals[moduleName] = exports;

      return multipleExports ? exports : singleGlobal;
    }
  }));
})();
});
//# sourceMappingURL=build.js.map