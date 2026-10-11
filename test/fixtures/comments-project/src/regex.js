const clean = (s) => s.replace(/'/g, ''); // rs.track("after_regex_quote")
const slash = (s) => s.replace(/\/*$/, '');
rs.track('regex_kept');
const n = 1 /* rs.track("block_after_number")
  rs.track("block_after_number_line_two") */;
function f() {
  return /* rs.track("block_after_return")
    rs.track("block_after_return_line_two") */ 0;
}
const label = 'done' /*
  rs.track("block_after_string") */;
rs.track('after_blocks');
