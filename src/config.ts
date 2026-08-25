/**
 * Client id of the OAuth app this plugin authenticates through.
 *
 * This value is public by design. GitHub's device flow needs no client secret,
 * which is exactly what makes it safe to ship in an open-source bundle: there is
 * nothing here an attacker can use. Every install shares this id, the same way
 * the GitHub CLI ships one.
 *
 * Users who would rather authorize through their own OAuth app can override it
 * in settings; anyone forking this plugin should register their own and replace
 * the value below.
 *
 * To create one: GitHub Settings -> Developer settings -> OAuth Apps -> New OAuth
 * App, then turn on "Enable Device Flow" in the app's settings. It is off by default.
 */
export const BUNDLED_CLIENT_ID = "";

export const OAUTH_APP_SETUP_URL = "https://github.com/settings/developers";
export const FINE_GRAINED_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
