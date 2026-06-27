local _ = require("gettext")

return {
    name = "vocabcloudsync",
    fullname = _("Vocabulary cloud auto-sync"),
    description = _([[Automatically syncs KOReader's Vocabulary Builder database to a configured WebDAV (or Dropbox) server, both periodically and on suspend. Reuses the server already configured for the built-in Vocabulary Builder "Cloud sync" feature, or any WebDAV entry from the cloud storage settings. Silently skips when offline.]]),
}
