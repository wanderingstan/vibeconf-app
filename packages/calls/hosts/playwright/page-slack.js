// The Slack huddle popup for the Playwright host (page-host.js). Slack's main
// window gets only the media core; this runs in the about:blank popup it opens.
require('./page-host').hostPage(require('../../providers/slack-session').startSlackHuddle);
