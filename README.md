# Email tracker (self-hosted, invisible)

Serves a 1x1 transparent GIF at `/api/track?t=<token>` and logs each fetch
to Vercel Blob, one JSON blob per open.

- The pixel is invisible in a normal email: 1x1, transparent, no text, no
  border, no link. It is not `display:none` (some mail apps skip hidden
  images entirely); it is a real 1px image at the end of the body.
- The token is an opaque hash created when the email is drafted. It is not
  an email address, and the token-to-recipient map lives only in the
  sender's private workspace, never in this repo.
- No third-party tracker is involved. Opens are read back from the Blob
  store in the Vercel dashboard, or by the agent that owns the outreach.
- Known limits, stated honestly: mail apps that block images will not
  count as opened, and Gmail/Apple image proxies can fetch once and cache,
  so repeat opens by the same person may not re-fetch. A reply is still
  the only reliable signal.

## Pixel HTML (added at the very end of the email body)

```html
<img src="https://<your-vercel-domain>/api/track?t=TOKEN" width="1" height="1" style="display:block;width:1px;height:1px;border:0;" alt="">
```

## Setup

1. Import this repo into Vercel.
2. Create a Vercel Blob store and connect it to the project (this sets
   `BLOB_READ_WRITE_TOKEN` automatically).
3. Deploy. Test with `https://<domain>/api/ping` (should return ok:true),
   then load a track URL once and check the Blob store for a new
   `opens/<token>/...json` file.
