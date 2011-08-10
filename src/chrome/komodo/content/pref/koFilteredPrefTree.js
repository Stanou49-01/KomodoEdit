/* Copyright (c) 2000-2011 ActiveState Software Inc.
   See the file LICENSE.txt for licensing information. */

var koFilteredTreeView = {};
(function() {

const OPEN_NODE_PREFS_NAME = "filtered-prefs-open-nodes-by-id";
var log = ko.logging.getLogger('filtered-prefs');

var _openPrefTreeNodes;

function setupOpenPrefTreeNodes() {
    var prefs = opener.ko.prefs;
    var nativeJSON = Components.classes["@mozilla.org/dom/json;1"]
                        .createInstance(Components.interfaces.nsIJSON);
    if (!prefs.hasPref(OPEN_NODE_PREFS_NAME)) {
        _openPrefTreeNodes = {};
    } else {
        _openPrefTreeNodes = nativeJSON.decode(prefs.getStringPref(OPEN_NODE_PREFS_NAME));
    }
}

function saveOpenPrefTreeNodes() {
    var nativeJSON = Components.classes["@mozilla.org/dom/json;1"]
                        .createInstance(Components.interfaces.nsIJSON);
    opener.ko.prefs.setStringPref(OPEN_NODE_PREFS_NAME,
                           nativeJSON.encode(_openPrefTreeNodes));
}

function TreeInfoItem(id, isContainer, isOpen, cls, url, label, helptag) {
    this.id = id;
    this.isContainer = isContainer;
    this.cls = cls;
    this.url = url;
    this.label = label;
    this.helptag = helptag;
    this.level = 0; // for nsITreeView
    this.state = isOpen ? xtk.hierarchicalTreeView.STATE_OPENED : xtk.hierarchicalTreeView.STATE_CLOSED;
    this.filteredOut = false;
}

TreeInfoItem.prototype.getChildren = function() {
    return treeItemsByURI[this.url];
};

TreeInfoItem.prototype.hasChildren = function() {
    return this.isContainer && (this.url in treeItemsByURI);
};

TreeInfoItem.prototype.toString = function() {
    var s = [];
    for (var p in this) {
        var o = this[p];
        if (typeof(o) != "function") {
            s.push(p + ": " + o);
        }
    }
    return "{ " + s.join(", ") + " }";
}

var treeItemsByURI = {}; // URI => array of TreeInfoItem;

this.buildTree = function(root, key) {
    var i, lim, currentList, rootChildren = root.childNodes, isContainer, isOpen, url, item;
    var treeitem, treerow, treecell, treechildren;
    if (typeof(key) === "undefined") key = ""; // top-level
    if (!(key in treeItemsByURI)) {
        treeItemsByURI[key] = [];
    }
    currentList = treeItemsByURI[key];
    lim = rootChildren.length;
    if (key) {
        currentList.hasChildren = lim > 0;
    }
    for (var i = 0; i < lim; i++) {
        treeitem = rootChildren[i];
        treerow = treeitem.firstChild;
        treecell = treerow.firstChild;
        isContainer = treeitem.getAttribute("container") === "true";
        if (isContainer) {
            if (treeitem.id in _openPrefTreeNodes) {
                isOpen = _openPrefTreeNodes[treeitem.id];
            } else {
                isOpen = treeitem.getAttribute("open") === "true";
            }
        }
        url = treecell.getAttribute("url");
        item = new TreeInfoItem(treeitem.id,
                                isContainer,
                                isOpen,
                                treecell.getAttribute("class"),
                                url,
                                treecell.getAttribute("label"),
                                treecell.getAttribute("helptag"));
        currentList.push(item);
        if (isContainer) {
            if (treeitem.childNodes.length != 2) {
                throw new Error("container for url " + url + " has " + treeitem.childNodes.length + " nodes");
            }
            treechildren = treeitem.lastChild;
            if (treechildren.nodeName != "treechildren") {
                throw new Error("expected a treechildren node for url " + url + ", got " + treechildren.nodeName);
            }
            this.buildTree(treechildren, url);
        } else if (treeitem.childNodes.length != 1) {
            throw new Error("non-container has " + treeitem.childNodes.length + " nodes");
        }
    }
};

this.getPrefTreeView = function() {
    setupOpenPrefTreeNodes();
    var rows = treeItemsByURI[""];
    if (!rows || rows.length == 0) {
        this.buildTree(document.getElementById("panelChildren"), "");
        rows = treeItemsByURI[""];
        if (!rows || rows.length == 0) {
            throw new Error("No rows for PrefTreeView");
        }
    }
    this.prefTreeView = new PrefTreeView(rows);
    var s = [];
    for (var p in this) {
        s.push(p);
    }
    return this.prefTreeView;
};

function PrefTreeView(initial_rows) {
    xtk.hierarchicalTreeView.apply(this, [initial_rows]);
    this._atomService = Components.classes["@mozilla.org/atom-service;1"].
                            getService(Components.interfaces.nsIAtomService);
    this.filtering = false;
    // Three kinds of rows in this tree:
    // this._rows -- the current view of rows, which the parent class expects to work with
    //               it can be a filtered view
    // this._unfilteredRows -- the rows to show when there's no filter in place
    // this._totalRows -- the full tree of rows, which filtered rows are built from.
    this._unfilteredRows = this._rows;
    this._buildAllRows();
    this._processOpenContainerRows();    
};
PrefTreeView.prototype = new xtk.hierarchicalTreeView();
PrefTreeView.prototype.constructor = PrefTreeView;
// and other nsITreeView methods
PrefTreeView.prototype.getCellText = function(row, column) {
    return this._rows[row].label;
};
PrefTreeView.prototype.getCellValue = function(row, column) {
    if (typeof(row) == "undefined"
        || typeof(this._rows[row]) == "undefined"
        || typeof([column.id]) == "undefined"
        || typeof(this._rows[row][column.id]) == "undefined") {
        debugger;
    }
    return this._rows[row][column.id];
};
PrefTreeView.prototype.isContainerEmpty = function(row) {
    return false; // no empty containers in this tree
};
PrefTreeView.prototype.isContainer = function(row) { 
    return this._rows[row].isContainer;
};
PrefTreeView.prototype.isContainerOpen = function(row) {
    return this._rows[row].state == xtk.hierarchicalTreeView.STATE_OPENED;
};

PrefTreeView.prototype._buildAllRows = function() {
    var totalRows = [];
    var i, row, lim = this._rows.length;
    for (i = 0; i < lim; i ++) {
        row = this._rows[i];
        totalRows.push(row);
        if (row.isContainer) {
            var newRows = this._extendChildren(row, totalRows);
        }
    }
    this._totalRows = totalRows;
};

PrefTreeView.prototype._extendChildren = function(rowItem, totalRows) {
    var rows = [];
    var child;
    var state;
    var children = rowItem.getChildren();
    var child_level = rowItem.level + 1;
    for (var i = 0; i < children.length; i++) {
        child = children[i];
        child.level = child_level;
        totalRows.push(child);
        if (child.isContainer) {
            rows = rows.concat(this._extendChildren(child, totalRows));
        }
    }
    
};

PrefTreeView.prototype.toggleOpenState = function(row, updateTree) {
    if (this.filtering) {
        // don't bother updating toggles while we're filtering
        return;
    }
    var item = this._rows[row];
    if (!item.isContainer) {
        return;
    }
    if (typeof(updateTree) == "undefined") updateTree = true;
    var old_row_length = this._rows.length;
    var new_rows;

    if (item.state === xtk.hierarchicalTreeView.STATE_CLOSED) {
        var children = [];
        this._expand_child_rows(item, children);
        new_rows = this._rows.slice(0, row+1);
        new_rows = new_rows.concat(children);
        new_rows = new_rows.concat(this._rows.slice(row+1));
        item.state = xtk.hierarchicalTreeView.STATE_OPENED;
    } else {
        var level = this._rows[row].level;
        var r = row + 1;
        var end = this._rows.length;
        while (r < end && this._rows[r].level > level) {
            if (this._rows[r].level <= level)
                break;
            r++;
        }
        new_rows = this._rows.slice(0, row+1);
        new_rows = new_rows.concat(this._rows.slice(r));
        item.state = xtk.hierarchicalTreeView.STATE_CLOSED;
    }

    var num_rows_changed = new_rows.length - this._rows.length;
    this._rows = new_rows;
    // Using rowCountChanged to notify rows were added
    if (updateTree) {
        _openPrefTreeNodes[item.id] = (item.state
                                   === xtk.hierarchicalTreeView.STATE_OPENED);
        this.tree.rowCountChanged(row+1, num_rows_changed);
        this.tree.invalidateRow(row); // To redraw the twisty.
    }
};

PrefTreeView.prototype.doClose = function() {
    saveOpenPrefTreeNodes();
};

PrefTreeView.prototype._processOpenContainerRows = function() {
    var i, row, lim = this._rows.length;
    for (var i = lim - 1; i >= 0; i--) {
        row = this._rows[i];
        if (row.isContainer
            && row.state === xtk.hierarchicalTreeView.STATE_OPENED) {
            // get toggleOpenState to do all the work
            row.state = xtk.hierarchicalTreeView.STATE_CLOSED;
            this.toggleOpenState(i, /*updateTree=*/ false);
        }
    }
};

PrefTreeView.prototype._expand_child_rows = function(rowItem, newChildren) {
    var child_level = rowItem.level + 1;
    var this_ = this;
    rowItem.getChildren().forEach(function(child) {
        child.level = child_level;
        newChildren.push(child);
        if (child.state === xtk.hierarchicalTreeView.STATE_OPENED && child.isContainer) {
            this_._expand_child_rows(child, newChildren);
        }
    })
};

PrefTreeView.prototype._applyFilter = function(status) {
    this._rows.forEach(function(row) { row.filteredOut = status; });
}
PrefTreeView.prototype.removeFilter = function() {
    this.filtering = false;
    this._applyFilter(false);
    var oldCount = this._rows.length;
    this._rows = this._unfilteredRows;
    this.tree.rowCountChanged(oldCount, this._rows.length - oldCount);
    this.tree.invalidate();
};
PrefTreeView.prototype.filterEverything = function() {
    this.filtering = true;
    this._applyFilter(true);
    var oldCount = this._rows.length;
    this._rows = [];
    this.tree.rowCountChanged(0, -oldCount);
    this.tree.invalidate();
};
PrefTreeView.prototype.updateFilter = function(urls) {
    var i, j, i1, row;
    var originalRows = this._rows;
    var oldCount = this._rows.length;
    // assign the total rows to this._rows so getParentIndex can work
    this._rows = this._totalRows;
    this._rows.forEach(function(rowItem) {
        rowItem.filteredOut = true;
        if (rowItem.isContainer) {
            rowItem.state = xtk.hierarchicalTreeView.STATE_CLOSED;
        }
    });
    var lim = this._rows.length;
    for (i = lim - 1; i >= 0; i--) {
        row = this._rows[i];
        if (row.filteredOut && urls.indexOf(row.url) != -1) {
            row.filteredOut = false;
            i1 = i;
            while ((j = this.getParentIndex(i1)) != -1) {
                this._rows[j].filteredOut = false;
                this._rows[j].state = xtk.hierarchicalTreeView.STATE_OPENED;
                i1 = j;
            }
        }
    }
    this.filtering = true;
    var newFilteredRows = this._rows.filter(function(row) !row.filteredOut);
    this._rows = newFilteredRows;
    this.tree.rowCountChanged(0, newFilteredRows.length - oldCount);
    this.tree.invalidate();
};
PrefTreeView.prototype.getIndexById = function(id) {
    for (var i = this._rows.length - 1; i >= 0; i--) {
        if (this._rows[i].id === id) {
            break;
        }
    }
    return -1;
}

this.PrefTreeView = PrefTreeView;

this.findBounds = function(target) {
    // find the lowest i s.t. wordList[i] >= target
    if (!target) return -1;
    var lb = 0, hb = this.wordList.length - 1, mid;
    while (lb <= hb) {
        mid = Math.floor((lb + hb) / 2);
        var currentWord = this.wordList[mid];
        if (currentWord < target) {
            lb = mid + 1;
        } else if (currentWord == target) {
            return mid;
        } else if (mid == lb || this.wordList[mid - 1] < target) {
            // currentWord > target for rest
            return mid;
        } else {
            hb = mid - 1;
        }
    }
    return -1;
}

this.updateFilter = function(target) {
    if (!target) {
        this.prefTreeView.removeFilter();
        return;
    }
    target = target.toLowerCase();
    var hit = this.findBounds(target);
    if (hit == -1) {
        this.prefTreeView.filterEverything();
        return;
    }
    var hits = {};
    var word, lim = this.wordList.length;
    for (var i = hit; i < lim; i++) {
        word = this.wordList[i];
        if (word.indexOf(target) != 0) {
            break;
        }
        for each (var num in this.fullTextManager.numsFromWord(word)) {
            hits[num] = 1;
        }
    }
    var urls = [];
    for (var num in hits) {
        urls.push(this.urlManager.URLsFromNums(num));
    }
    this.prefTreeView.updateFilter(urls); 
   
};

function URLManager() {
    this._urlToNumber = {};
    this._numberToURL = {};
    this._docNumber = 0;
}
URLManager.prototype = {
    intern: function(url) {
        if (url in this._urlToNumber) {
            return this._urlToNumber[url];
        }
        this._docNumber += 1;
        this._urlToNumber[url] = this._docNumber;
        this._numberToURL[this._docNumber] = url;
        return this._docNumber;
    },
    URLsFromNums: function(num) {
        return this._numberToURL[num];
    },
    __EOF__:null
};

function FullTextManager() {
    this._hits_for_word = {};
    this._hits_list = {};
    this.stopWords = {};
};
FullTextManager.prototype = {
    loadStopWords: function() {
        var indexURI = "chrome://komodo/content/pref/stopWords.txt";
        var req = new XMLHttpRequest();
        var this_ = this; // bind isn't working.
        req.onreadystatechange = function() {
            if (req.readyState == 4 && (req.status == 200 || req.status == 0)) { // 0? it happens...
                var contents = req.responseText.toLowerCase();
                var words = contents.split(/\s+/);
                words.forEach(function(word) {
                    this_.stopWords[word] = 1;
                });
            }
        };
        req.open("GET", indexURI, true);
        req.overrideMimeType('text/plain; charset=x-user-defined');
        req.send(null);
    },

    record: function(word, urlNum) {
        if (word && !(word in this.stopWords)) {
            if (!(word in this._hits_for_word)) {
                this._hits_for_word[word] = {};
            }
            this._hits_for_word[word][urlNum] = 1;
        }
    },
    getWordList: function() {
        var wordList = [];
        for (var w in this._hits_for_word) {
            wordList.push(w);
        }
        wordList.sort();
        return wordList;
    },
    
    numsFromWord: function(word) {
        if (!(word in this._hits_for_word)) {
            return [];
        } else if (word in this._hits_list) {
            return this._hits_list[word];
        } else {
            var nums = [];
            for (var p in this._hits_for_word[word]) {
                nums.push(p);
            }
            nums.sort();
            this._hits_list[word] = nums;
            return nums;
        }
    },
    __EOF__:null
};

this.loadPrefsFullText = function() {
    var tree = document.getElementById("prefsTree");
    var elts = tree.getElementsByTagName("treecell");
    var lim = elts.length;
    var urls = []
    var i, elt, url;
    for (i = 0; elt = elts[i]; i++) {
        if (!!(url = elt.getAttribute("url"))) {
            urls.push(url);
        }
    }
    const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
    var this_ = this;
    this.urlManager = new URLManager();
    this.fullTextManager = new FullTextManager();
    this.fullTextManager.loadStopWords();
    var parser = new DOMParser();
    
    var DocLoader = function() {
        this.urlIndex = 0;
        this.urlCount = urls.length;
        this.overlays = {}; // hash of overlay URLs to an array of urls
        this.overlayURLs = [];
        this.beforeOverlays = true;
    };
    DocLoader.prototype.doNextURL = function() {
        if (this.urlIndex >= this.urlCount) {
            if (this.beforeOverlays) {
                this.beforeOverlays = false;
                this.urlIndex = 0;
                this.urlCount = this.overlayURLs.length;
                urls = this.overlayURLs;
            } else {
                this.getTopLevelWords();
                this_.wordList = this_.fullTextManager.getWordList();
                //document.getElementById("pref-filter-textbox").removeAttribute("readonly");
                return;
            }
        }
        var url = urls[this.urlIndex];
        
        var req = new XMLHttpRequest();
        var docLoader = this;
        req.onreadystatechange = function() {
            if (req.readyState == 4 && (req.status == 200 || req.status == 0)) { // 0? it happens...
                docLoader.onDocLoaded(req.responseXML);
            }
        };
        req.open("GET", url, true);
        req.overrideMimeType('text/xml; charset=utf-8');
        req.send(null);
    };
    DocLoader.prototype.onDocLoaded = function(docObject) {
        var i, len, cd1, node;
        var url = urls[this.urlIndex];

        var phrases = [];
        var xpr = docObject.getElementsByTagNameNS(XUL_NS, "description");
        len = xpr.length;
        for (var i = 0; i < len; i++) {
            phrases.push(xpr[i].textContent.toLowerCase());
        }
        xpr = docObject.getElementsByTagNameNS(XUL_NS, "label");
        len = xpr.length;
        for (var i = 0; i < len; i++) {
            phrases.push(xpr[i].getAttribute("value").toLowerCase());
        }
        var attrNames = {"label":true, "tooltiptext":true};
        for (var attrName in attrNames) {
            xpr = docObject.evaluate("//*/@" + attrName, docObject, null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null );
            for (var i = 0; i < xpr.snapshotLength; i++) {
                try {
                    phrases.push(xpr.snapshotItem(i).value.toLowerCase());
                }  catch(ex) {
                    log.error("Problem getting attr " + attrName + ":" + ex);
                }
            }
        }
        // Watch out for overlays
        if (this.beforeOverlays) {
            // No, we don't bother with nested overlays....
            len = docObject.childNodes.length;
            const PINode = docObject.childNodes[0].PROCESSING_INSTRUCTION_NODE;
            for (var i = 0; i < len && !!(node = docObject.childNodes[i]); i++) {
                if (node.nodeType == PINode && node.nodeName == "xul-overlay") {
                    var data = node.data;
                    var m = /href="(.*?)"/.exec(node.data);
                    if (m && m[1]) {
                        var overlayURI = m[1];
                        if (!(overlayURI in this.overlays)) {
                            this.overlays[overlayURI] = [];
                            this.overlayURLs.push(overlayURI);
                        }
                        this.overlays[overlayURI].push(url);
                    }
                }
            }
        }
        if (phrases.length) {
            var words = this.getWordPrefixes(phrases.join(" "));
            if (this.beforeOverlays) {
                this.internWords(url, words, this_);
            } else {
                var targetURLs = this.overlays[url];
                var i, lim = targetURLs.length;
                for (i = 0; i < lim; i++) {
                    this.internWords(targetURLs[i], words, this_);
                }
            }
        }
        this.urlIndex += 1;
        this.doNextURL();
    };
    DocLoader.prototype.getTopLevelWords = function(docObject) {
        var nodes = document.getElementsByTagName("treecell");
        var lim = nodes.length;
        var i, node, label, url, words;
        var phrases = [];
        for (var i = 0; i < lim && (node = nodes[i]); i++) {
            label = node.getAttribute("label").toLowerCase(); 
            url = node.getAttribute("url");
            if (label && url) {
                words = this.getWordPrefixes(label);
                this.internWords(url, words, this_);
            }
        }
    };
    DocLoader.prototype.getWordPrefixes = function(s) {
        // Handles latin1 characters only
        return s.replace(/([a-zA-Z\xa0-\xff])[^a-zA-Z\xa0-\xff_\-\'\s]+/g, "$1").
                 replace(/[^a-zA-Z\xa0-\xff\'\-\_]+/g, " ").
                 split(/\s+/);
    };
    DocLoader.prototype.internWords = function(url, words, owner) {
        var urlNum = owner.urlManager.intern(url);
        words.forEach(function(word) {
            owner.fullTextManager.record(word, urlNum);
        });
    };

    (new DocLoader()).doNextURL();
};

}).apply(koFilteredTreeView);