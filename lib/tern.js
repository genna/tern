// The Tern server object

// A server is a stateful object that manages the analysis for a
// project, and defines an interface for querying the code in the
// project.

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    return mod(exports, require("./infer"), require("acorn/util/walk"));
  if (typeof define == "function" && define.amd) // AMD
    return define(["exports", "./infer", "acorn/util/walk"], mod);
  mod(self.tern || (self.tern = {}), tern, acorn.walk); // Plain browser env
})(function(exports, infer, walk) {
  "use strict";

  var plugins = Object.create(null);
  exports.registerPlugin = function(name, init) { plugins[name] = init; };

  var defaultOptions = {
    debug: false,
    async: false,
    getFile: function(_f, c) { if (this.async) c(null, null); },
    defs: [],
    plugins: {},
    fetchTimeout: 1000
  };

  var queryTypes = {
    completions: {
      takesFile: true,
      run: findCompletions
    },
    properties: {
      run: findProperties
    },
    type: {
      takesFile: true,
      run: findTypeAt
    },
    documentation: {
      takesFile: true,
      run: findDocs
    },
    definition: {
      takesFile: true,
      run: findDef
    },
    refs: {
      takesFile: true,
      fullFile: true,
      run: findRefs
    },
    rename: {
      takesFile: true,
      fullFile: true,
      run: buildRename
    },
    files: {
      run: listFiles
    }
  };

  exports.defineQueryType = function(name, desc) { queryTypes[name] = desc; };

  function File(name) {
    this.name = name;
    this.scope = this.text = this.ast = this.lineOffsets = null;
  }
  function updateText(file, text) {
    file.text = text;
    file.ast = infer.parse(text);
    file.lineOffsets = null;
  }

  var Server = exports.Server = function(options) {
    this.cx = null;
    this.options = options || {};
    for (var o in defaultOptions) if (!options.hasOwnProperty(o))
      options[o] = defaultOptions[o];

    this.handlers = {};
    this.files = [];
    this.analyses = 0;
    this.fetchingFiles = 0;
    this.asyncError = null;

    this.defs = options.defs.slice(0);
    for (var plugin in options.plugins) if (options.plugins.hasOwnProperty(plugin)) {
      var init = plugins[plugin](this, options.plugins[plugin]);
      if (init && init.defs) this.defs.push(init.defs);
    }

    this.reset();
  };
  Server.prototype = {
    addFile: function(name, /*optional*/ text) {
      ensureFile(this, name, text);
    },
    delFile: function(name) {
      for (var i = 0, f; i < this.files.length; ++i) if ((f = this.files[i]).name == name) {
        clearFile(this, f);
        this.files.splice(i--, 1);
        return;
      }
    },
    reset: function() {
      this.cx = new infer.Context(this.defs, this);
      this.analyses = 0;
      for (var i = 0; i < this.files.length; ++i) clearFile(this, this.files[i]);
      this.signal("reset");
    },

    request: function(doc, c) {
      var inv = invalidDoc(doc);
      if (inv) return c(inv);

      var self = this, files = doc.files || [];
      doRequest(this, doc, function(err, data) {
        c(err, data);
        if (self.analyses > 40) {
          self.reset();
          analyzeAll(self, function(){});
        }
      });
    },

    findFile: function(name) {
      return findFile(this.files, name);
    },

    flush: function(c) {
      var cx = this.cx;
      analyzeAll(this, function(err) {
        if (err) return c(err);
        infer.withContext(cx, c);
      });
    },

    on: function(type, f) {
      (this.handlers[type] || (this.handlers[type] = [])).push(f);
    },
    off: function(type, f) {
      var arr = this.handlers[type];
      if (arr) for (var i = 0; i < arr.length; ++i)
        if (arr[i] == f) { arr.splice(i, 1); break; }
    },
    signal: function(type, v1, v2, v3, v4) {
      var arr = this.handlers[type];
      if (arr) for (var i = 0; i < arr.length; ++i) arr[i].call(this, v1, v2, v3, v4);
    }
  };

  function doRequest(srv, doc, c) {
    if (doc.query && !queryTypes.hasOwnProperty(doc.query.type))
      return c("No query type '" + doc.query.type + "' defined");

    var query = doc.query;
    // Respond as soon as possible when this just uploads files
    if (!query) c(null, {});

    var files = doc.files || [];
    for (var i = 0; i < files.length; ++i) {
      var file = files[i];
      ensureFile(srv, file.name, file.type == "full" ? file.text : null)
    }

    if (!query) {
      analyzeAll(srv, function(){});
      return;
    }

    var queryType = queryTypes[query.type];
    if (queryType.takesFile) {
      if (typeof query.file != "string") return c(".query.file must be a string");
      if (!/^#/.test(query.file)) ensureFile(srv, query.file);
    }

    analyzeAll(srv, function(err) {
      if (err) return c(err);
      var file = queryType.takesFile && resolveFile(srv, files, query.file);
      if (queryType.fullFile && file.type == "part")
        return c("Can't run a " + query.type + " query on a file fragment");

      infer.withContext(srv.cx, function() {
        var result;
        try {
          result = queryType.run(srv, query, file);
        } catch (e) {
          if (srv.options.debug) console.log(e.stack);
          return c(e);
        }
        c(null, result);
      });
    });
  }

  function analyzeFile(srv, file) {
    ++srv.analyses;
    infer.withContext(srv.cx, function() {
      file.scope = srv.cx.topScope;
      srv.signal("beforeLoad", file);
      infer.markVariablesDefinedBy(file.scope, file.name);
      infer.analyze(file.ast, file.name, file.scope);
      infer.purgeMarkedVariables(file.scope);
      srv.signal("afterLoad", file);
    });
    return file;
  }

  function ensureFile(srv, name, text) {
    var known = findFile(srv.files, name);
    if (known) {
      if (text) clearFile(srv, known, text);
      return;
    }

    var file = new File(name);
    srv.files.push(file);
    if (text) {
      updateText(file, text)
    } else if (srv.options.async) {
      ++srv.fetchingFiles;
      srv.options.getFile(name, function(err, text) {
        if (err) srv.asyncError = err;
        updateText(file, text || "");
        if (--srv.fetchingFiles == 0) srv.signal("everythingFetched");
      });
    } else {
      updateText(file, srv.options.getFile(name) || "");
    }
  }

  function clearFile(srv, file, newText) {
    if (file.scope) {
      // FIXME try to batch purges into a single pass (each call needs
      // to traverse the whole graph)
      infer.withContext(srv.cx, function() {
        infer.purgeTypes(file.name);
      });
      file.scope = null;
    }
    if (newText != null) updateText(file, newText);
  }

  function fetchAll(srv, c) {
    var done = true, returned = false;
    for (var i = 0; i < srv.files.length; ++i) {
      var file = srv.files[i];
      if (file.text != null) continue;
      if (srv.options.async) {
        done = false;
        srv.options.getFile(file.name, function(err, text) {
          if (err && !returned) { returned = true; return c(err); }
          updateText(file, text || "");
          fetchAll(srv, c);
        });
      } else {
        try {
          updateText(file, srv.options.getFile(file.name) || "");
        } catch (e) { return c(e); }
      }
    }
    if (done) c();
  }

  function waitOnFetch(srv, c) {
    var done = function() {
      srv.off("everythingFetched", done);
      clearTimeout(timeout);
      analyzeAll(srv, c);
    }
    srv.on("everythingFetched", done);
    var timeout = setTimeout(done, srv.options.fetchTimeout);
  }

  function analyzeAll(srv, c) {
    if (srv.fetchingFiles) return waitOnFetch(srv, c);

    var e = srv.fetchError;
    if (e) { srv.fetchError = null; return c(e); }

    var done = true;
    for (var i = 0; i < srv.files.length; ++i) {
      var file = srv.files[i];
      if (file.text == null) done = false;
      else if (file.scope == null) analyzeFile(srv, file);
    }
    if (done) c();
    else waitOnFetch(srv, c);
  }

  function findFile(arr, name) {
    for (var i = 0; i < arr.length; ++i) {
      var file = arr[i];
      if (file.name == name && file.type != "part") return file;
    }
  }

  function firstLine(str) {
    var end = str.indexOf("\n");
    if (end < 0) return str;
    return str.slice(0, end);
  }

  function findMatchingPosition(line, file, near) {
    var pos = Math.max(0, near - 500), closest = null;
    if (!/^\s*$/.test(line)) for (;;) {
      var found = file.indexOf(line, pos);
      if (found < 0 || found > near + 500) break;
      if (closest == null || Math.abs(closest - near) > Math.abs(found - near))
        closest = found;
      pos = found + line.length;
    }
    return closest;
  }

  function scopeDepth(s) {
    for (var i = 0; s; ++i, s = s.prev) {}
    return i;
  }

  function resolveFile(srv, localFiles, name) {
    var isRef = name.match(/^#(\d+)$/);
    if (!isRef) return findFile(srv.files, name);

    var file = localFiles[isRef[1]];
    if (!file) throw new Error("Reference to unknown file " + name);
    if (file.type == "full") return findFile(srv.files, file.name);

    // This is a partial file

    var realFile = findFile(srv.files, file.name);
    var offset = file.offset;
    if (offset == null)
      offset = file.offset = findLineStart(realFile, file.offsetLines) || 0;
    var line = firstLine(file.text);
    var foundPos = findMatchingPosition(line, realFile.text, offset);
    var pos = foundPos == null ? Math.max(0, realFile.text.lastIndexOf("\n", offset)) : foundPos;

    infer.withContext(srv.cx, function() {
      infer.purgeTypes(file.name, pos, pos + file.text.length);

      var text = file.text, m;
      if (foundPos && (m = line.match(/^(.*?)\bfunction\b/))) {
        var cut = m[1].length, white = "";
        for (var i = 0; i < cut; ++i) white += " ";
        text = white + text.slice(cut);
      }
      var scopeStart = infer.scopeAt(realFile.ast, pos, realFile.scope);
      var scopeEnd = infer.scopeAt(realFile.ast, pos + text.length, realFile.scope);
      var scope = file.scope = scopeDepth(scopeStart) < scopeDepth(scopeEnd) ? scopeEnd : scopeStart;
      infer.markVariablesDefinedBy(scopeStart, file.name, pos, pos + file.text.length);
      file.ast = infer.parse(file.text);
      infer.analyze(file.ast, file.name, scope);
      infer.purgeMarkedVariables(scopeStart);

      // This is a kludge to tie together the function types (if any)
      // outside and inside of the fragment, so that arguments and
      // return values have some information known about them.
      var inner = infer.scopeAt(realFile.ast, pos + line.length, realFile.scope);
      if (m && inner != scope && inner.fnType) {
        var newInner = infer.scopeAt(file.ast, line.length, scope);
        var fOld = inner.fnType, fNew = newInner.fnType;
        if (fNew && (fNew.name == fOld.name || !fOld.name)) {
          for (var i = 0, e = Math.min(fOld.args.length, fNew.args.length); i < e; ++i)
            fOld.args[i].propagate(fNew.args[i]);
          fOld.self.propagate(fNew.self);
          fNew.retval.propagate(fOld.retval);
        }
      }
    });
    return file;
  }

  function isPosition(val) {
    return typeof val == "number" || typeof val == "object" &&
      typeof val.line == "number" && typeof val.ch == "number";
  }

  // Baseline query document validation
  function invalidDoc(doc) {
    if (doc.query) {
      if (typeof doc.query.type != "string") return ".query.type must be a string";
      if (doc.query.start && !isPosition(doc.query.start)) return ".query.start must be a number";
      if (doc.query.end && !isPosition(doc.query.end)) return ".query.end must be a number";
    }
    if (doc.files) {
      if (!Array.isArray(doc.files)) return "Files property must be an array";
      for (var i = 0; i < doc.files.length; ++i) {
        var file = doc.files[i];
        if (typeof file != "object") return ".files[n] must be objects";
        else if (typeof file.text != "string") return ".files[n].text must be a string";
        else if (typeof file.name != "string") return ".files[n].name must be a string";
        else if (file.type == "part") {
          if (typeof file.offset != "number" && typeof file.offsetLines != "number")
            return ".files[n].offset or .files[n].offsetLines must be a number";
        } else if (file.type != "full") return ".files[n].type must be \"full\" or \"part\"";
      }
    }
  }

  var offsetSkipLines = 25;

  function findLineStart(file, line) {
    var text = file.text, offsets = file.lineOffsets || (file.lineOffsets = [0]);
    var pos = 0, curLine = 0;
    var storePos = Math.min(Math.floor(line / offsetSkipLines), offsets.length - 1);
    var pos = offsets[storePos], curLine = storePos * offsetSkipLines;

    while (curLine < line) {
      ++curLine;
      pos = text.indexOf("\n", pos) + 1;
      if (pos == 0) return null;
      if (curLine % offsetSkipLines == 0) offsets.push(pos);
    }
    return pos;
  }

  function resolvePos(file, pos) {
    if (typeof pos != "number") {
      var lineStart = findLineStart(file, pos.line);
      if (lineStart == null) throw new Error("File doesn't contain a line " + pos.line);
      pos = lineStart + pos.ch;
    }
    if (pos > file.text.length) throw new Error("Position " + pos + " is outside of file.");
    return pos;
  }

  function asLineChar(file, pos) {
    if (!file) return {line: 0, ch: 0};
    var offsets = file.lineOffsets || (file.lineOffsets = [0]);
    var text = file.text, line, lineStart;
    for (var i = offsets.length - 1; i >= 0; --i) if (offsets[i] <= pos) {
      line = i * offsetSkipLines;
      lineStart = offsets[i];
    }
    for (;;) {
      var eol = text.indexOf("\n", lineStart);
      if (eol >= pos || eol < 0) break;
      lineStart = eol + 1;
      ++line;
    }
    return {line: line, ch: pos - lineStart};
  }

  function outputPos(query, file, pos) {
    if (query.lineCharPositions) {
      var out = asLineChar(file, pos);
      if (file.type == "part")
        out.line += file.offsetLines != null ? file.offsetLines : asLineChar(file, file.offset).line;
      return out;
    } else {
      return pos + (file.type == "part" ? file.offset : 0);
    }
  }

  // Delete empty fields from result objects
  function clean(obj) {
    for (var prop in obj) if (obj[prop] == null) delete obj[prop];
    return obj;
  }
  function maybeSet(obj, prop, val) {
    if (val != null) obj[prop] = val;
  }

  // Built-in query types

  function compareCompletions(a, b) {
    if (typeof a != "string") { a = a.name; b = b.name; }
    var aUp = /^[A-Z]/.test(a), bUp = /^[A-Z]/.test(b);
    if (aUp == bUp) return a < b ? -1 : a == b ? 0 : 1;
    else return aUp ? 1 : -1;
  }

  function isStringAround(node, start, end) {
    return node.type == "Literal" && typeof node.value == "string" &&
      node.start == start - 1 && node.end <= end + 1;
  }

  function findCompletions(srv, query, file) {
    if (query.end == null) throw new Error("missing .query.end field");
    var wordStart = resolvePos(file, query.end), wordEnd = wordStart, text = file.text;
    while (wordStart && /\w$/.test(text.charAt(wordStart - 1))) --wordStart;
    if (query.expandWordForward !== false)
      while (wordEnd < text.length && /\w$/.test(text.charAt(wordEnd))) ++wordEnd;
    var word = text.slice(wordStart, wordEnd), completions = [];
    var wrapAsObjs = query.types || query.depths || query.docs || query.urls || query.origins;

    function gather(prop, obj, depth) {
      // 'hasOwnProperty' and such are usually just noise, leave them
      // out when no prefix is provided.
      if (query.omitObjectPrototype !== false && obj == srv.cx.protos.Object && !word) return;
      if (query.filter !== false && word && prop.indexOf(word) != 0) return;
      for (var i = 0; i < completions.length; ++i) {
        var c = completions[i];
        if ((wrapAsObjs ? c.name : c) == prop) return;
      }
      var rec = wrapAsObjs ? {name: prop} : prop;
      completions.push(rec);

      if (query.types || query.docs || query.urls || query.origins) {
        var val = obj ? obj.props[prop] : infer.ANull;
        infer.resetGuessing();
        var type = val.getType();
        rec.guess = infer.didGuess();
        if (query.types)
          rec.type = infer.toString(type);
        if (query.docs)
          maybeSet(rec, "doc", val.doc || type && type.doc);
        if (query.urls)
          maybeSet(rec, "url", val.url || type && type.url);
        if (query.origins)
          maybeSet(rec, "origin", val.origin || type && type.origin);
      }
      if (query.depths) rec.depth = depth;
    }

    var memberExpr = infer.findExpressionAround(file.ast, null, wordStart, file.scope, "MemberExpression");
    if (memberExpr &&
        (memberExpr.node.computed ? isStringAround(memberExpr.node.property, wordStart, wordEnd)
                                  : memberExpr.node.object.end < wordStart)) {
      var prop = memberExpr.node.property;
      prop = prop.type == "Literal" ? prop.value.slice(1) : prop.name;

      memberExpr.node = memberExpr.node.object;
      var tp = infer.expressionType(memberExpr);
      if (tp) infer.forAllPropertiesOf(tp, gather);

      if (!completions.length && query.guess !== false && tp && tp.guessProperties) {
        tp.guessProperties(function(p, o, d) {if (p != prop && p != "✖") gather(p, o, d);});
      }
      if (!completions.length && word.length >= 2 && query.guess !== false)
        for (var prop in srv.cx.props) gather(prop, srv.cx.props[prop][0], 0);
    } else {
      infer.forAllLocalsAt(file.ast, wordStart, file.scope, gather);
    }

    if (query.sort !== false) completions.sort(compareCompletions);

    return {start: outputPos(query, file, wordStart),
            end: outputPos(query, file, wordEnd),
            completions: completions};
  }

  function findProperties(srv, query) {
    var prefix = query.prefix, found = [];
    for (var prop in srv.cx.props)
      if (prop != "<i>" && (!prefix || prop.indexOf(prefix) == 0)) found.push(prop);
    if (query.sort !== false) found.sort(compareCompletions);
    return {completions: found};
  }

  var findExpr = exports.findQueryExpr = function(file, query) {
    if (query.end == null) throw new Error("missing .query.end field");

    if (query.variable) {
      var scope = infer.scopeAt(file.ast, query.end, file.scope);
      return {node: {type: "Identifier", name: query.variable, start: query.end, end: query.end + 1},
              state: scope};
    } else {
      var start = query.start && resolvePos(file, query.start), end = resolvePos(file, query.end);
      var expr = infer.findExpressionAt(file.ast, start, end, file.scope);
      if (expr) return expr;
      expr = infer.findExpressionAround(file.ast, start, end, file.scope);
      if (expr && (start == null || start - expr.node.start < 20 || expr.node.end - end < 20))
        return expr;
      throw new Error("No expression at the given position.");
    }
  };

  function findTypeAt(_srv, query, file) {
    var expr = findExpr(file, query);
    infer.resetGuessing();
    var type = infer.expressionType(expr);
    if (query.preferFunction)
      type = type.getFunctionType() || type.getType();
    else
      type = type.getType();

    if (expr.node.type == "Identifier")
      var exprName = expr.node.name;
    else if (expr.node.type == "MemberExpression" && !expr.node.computed)
      var exprName = expr.node.property.name;

    if (query.depth != null && typeof query.depth != "number")
      throw new Error(".query.depth must be a number");

    var result = {guess: infer.didGuess(),
                  type: infer.toString(type, query.depth),
                  name: type && type.name,
                  exprName: exprName};
    if (type) storeTypeDocs(type, result);

    return clean(result);
  }

  function findDocs(_srv, query, file) {
    var expr = findExpr(file, query), prop;
    var type = infer.expressionType(expr);
    var result = {url: type.url, doc: type.doc};
    var inner = type.getType();
    if (inner) storeTypeDocs(inner, result);
    return clean(result);
  }

  function isInAST(node, ast) {
    var found = walk.findNodeAt(ast, node.start, node.end, node.type, infer.searchVisitor);
    return found && found.node == node;
  }

  function storeTypeDocs(type, out) {
    if (!out.url) out.url = type.url;
    if (!out.doc) out.doc = type.doc;
    if (!out.origin) out.origin = type.origin;
    var ctor;
    if (!out.url && !out.doc && type.proto && (ctor = type.proto.hasCtor) &&
        type.proto != infer.cx().protos.Object) {
      out.url = ctor.url;
      out.doc = ctor.doc;
    }
  }

  function findDef(srv, query, file) {
    var expr = findExpr(file, query), fileName, guess = false;
    infer.resetGuessing();
    var type = infer.expressionType(expr), node = type.originNode;
    var result = {url: type.url, doc: type.doc, origin: type.origin};
    if (type.types) for (var i = type.types.length - 1; i >= 0; --i) {
      var tp = type.types[i];
      storeTypeDocs(tp, result);
      if (!node && tp.originNode) { node = tp.originNode; break; }
    }
    if (node) {
      if (/^Function/.test(node.type) && node.id) node = node.id;
      fileName = result.origin;
    }

    result.guess = infer.didGuess();
    if (node) {
      var inFragment = file.type == "part" && file.name == fileName && isInAST(node, file.ast);
      var outerFile = findFile(srv.files, fileName), nodeFile = inFragment ? file : outerFile;
      var start = outputPos(query, nodeFile, node.start), end = outputPos(query, nodeFile, node.end);
      result.start = start; result.end = end;
      result.file = fileName;
      var cxStart = Math.max(0, node.start - 50);
      result.contextOffset = node.start - cxStart;
      result.context = nodeFile.text.slice(cxStart, cxStart + 50);
    }
    return clean(result);
  }

  function findRefsToVariable(srv, query, file, expr, checkShadowing) {
    var name = expr.node.name;

    for (var scope = expr.state; scope && !(name in scope.props); scope = scope.prev) {}
    if (!scope) throw new Error("Could not find a definition for " + name);

    var type, refs = [];
    function storeRef(file) {
      return function(node, scopeHere) {
        if (checkShadowing) for (var s = scopeHere; s != scope; s = s.prev) {
          var exists = s.hasProp(checkShadowing);
          if (exists)
            throw new Error("Renaming `" + name + "` to `" + checkShadowing + "` would make a variable at line " +
                            (asLineChar(file, node.start).line + 1) + " point to the definition at line " +
                            (asLineChar(file, exists.name.start).line + 1));
        }
        refs.push({file: file.name,
                   start: outputPos(query, file, node.start),
                   end: outputPos(query, file, node.end)});
      };
    }

    if (scope.node) {
      type = "local";
      if (checkShadowing) {
        for (var prev = scope.prev; prev; prev = prev.prev)
          if (checkShadowing in prev.props) break;
        if (prev) infer.findRefs(scope.node, scope, checkShadowing, prev, function(node) {
          throw new Error("Renaming `" + name + "` to `" + checkShadowing + "` would shadow the definition used at line " +
                          (asLineChar(file, node.start).line + 1));
        });
      }
      infer.findRefs(scope.node, scope, name, scope, storeRef(file));
    } else {
      type = "global";
      for (var i = 0; i < srv.files.length; ++i) {
        var cur = srv.files[i];
        infer.findRefs(cur.ast, cur.scope, name, scope, storeRef(cur));
      }
    }

    return {refs: refs, type: type, name: name};
  }

  function findRefsToProperty(srv, query, expr) {
    var propName = expr.node.property.name;
    expr.node = expr.node.object;
    var objType = infer.expressionType(expr).getType();
    if (!objType) throw new Error("Couldn't determine type of base object.");

    var refs = [];
    function storeRef(file) {
      return function(node) {
        refs.push({file: file.name,
                   start: outputPos(query, file, node.start),
                   end: outputPos(query, file, node.end)});
      };
    }
    for (var i = 0; i < srv.files.length; ++i) {
      var cur = srv.files[i];
      infer.findPropRefs(cur.ast, cur.scope, objType, propName, storeRef(cur));
    }

    return {refs: refs, name: propName};
  }

  function findRefs(srv, query, file) {
    var expr = findExpr(file, query);
    if (expr && expr.node.type == "Identifier")
      return findRefsToVariable(srv, query, file, expr);
    if (expr && expr.node.type == "MemberExpression" && !expr.node.computed)
      return findRefsToProperty(srv, query, expr);
    throw new Error("Not at a variable or property name.");
  }

  function buildRename(srv, query, file) {
    if (typeof query.newName != "string") throw new Error(".query.newName should be a string");
    var expr = findExpr(file, query);
    if (!expr || expr.node.type != "Identifier") throw new Error("Not at a variable.");

    var data = findRefsToVariable(srv, query, file, expr, query.newName), refs = data.refs;
    delete data.refs;
    data.files = srv.files.map(function(f){return f.name;});

    var changes = data.changes = [];
    for (var i = 0; i < refs.length; ++i) {
      var use = refs[i];
      use.text = query.newName;
      changes.push(use);
    }

    return data;
  }

  function listFiles(srv, query) {
    return {files: srv.files.map(function(f){return f.name;})};
  }
});
