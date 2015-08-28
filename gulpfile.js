/* ====== dependencies ====== */
var gulp = require("gulp"),
    gutil = require("gulp-util"),
    rename = require("gulp-rename"),
    less = require("gulp-less"),
    path = require("path"),
    fs = require("fs"),

/* ====== project config ====== */
    pkg = require("./package.json"),
    destination = "./stylesheets",
    stylesheets_source = "./src/stylesheets",
    less_source = stylesheets_source + "/index.less",
    watched_files = stylesheets_source + "/**/*.less";

/* ====== error handlers ====== */
var lessErrorHandler = function(err) {
  var file_lines = fs.readFileSync(err.fileName).toString().split('\n'),
      buffer = 3,
      first_relevant_line,
      last_relevant_line,
      relevant_lines,
      excerpt;
  
  if (err.line) {
    first_relevant_line = err.line - 1 - buffer;
    if (first_relevant_line < 0) first_relevant_line = 0;

    last_relevant_line = err.line + buffer;
    if (last_relevant_line > file_lines.length) last_relevant_line = file_lines.length;

    relevant_lines = file_lines
      .slice(first_relevant_line, last_relevant_line)
      .map(function(item, i) {
        var line = first_relevant_line + 1 + i,
            prefix = line === err.line ? '\x1b[31m' : '',
            suffix = line === err.line ? '\x1b[0m' : '';
        return prefix + line + ': ' + item + suffix;
      });

    excerpt = relevant_lines.join('\n');
  }

  console.log('\x1b[33m' + err.name + ':', err.message + ':\x1b[0m');
  console.log(excerpt);
  console.log('\x1b[33mLess compilation aborted\x1b[0m');
  this.emit('end');
};

/* ====== tasks ====== */
gulp.task('less:development', function() {
  return gulp
    .src(less_source)
    .pipe(less())
    .on('error', lessErrorHandler)
    .pipe(rename(pkg.name + ".css"))
    .pipe(gulp.dest(destination));
});

gulp.task('less:production', function() {
  return gulp
    .src(less_source)
    .pipe(less({compress: true}))
    .pipe(rename(pkg.name + ".css"))
    .pipe(gulp.dest(destination));
});

gulp.task('watch', function() {
  return gulp
    .watch(watched_files, {debounceDelay: 1000}, ['less:development'])
    .on('change', function(e) {
      var relative_path = path.relative(__dirname, e.path);
      console.log('File \x1b[34m' + relative_path + '\x1b[0m was ' + e.type + ', running tasks...');
    });
});


/* ====== aliases ====== */
gulp.task("dev", ["less:development", "watch"]);
gulp.task("prod", ["less:production"]);
gulp.task("default", ["dev"]);
