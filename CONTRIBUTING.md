# Contributing

Thanks for helping improve this project.

## Before contributing

- Search existing issues and pull requests first.
- For a large change, open an issue before writing code.
- Never commit `.env`, `bot/accounts.json`, Discord tokens, cookies, session
  data, or deployment secrets.
- Do not submit features for spam, raids, token theft, account compromise, or
  bypassing Discord safety or enforcement systems.
- Remember that Discord prohibits self-bots and user-account automation. Use
  this project only where you accept that risk and responsibility.

## Development

Requirements: Node.js `>=20.18`.

```bash
npm install
npm test
```

Use `.env.example` or `bot/accounts.example.json` as configuration templates.
Keep real credentials outside the repository.

## Pull requests

Include:

- What changed and why.
- How the change was tested.
- Any configuration, compatibility, or safety impact.

Keep pull requests focused. Update README or examples when behavior or setup
changes. Do not include generated dependencies, local logs, or secret files.

## License

By contributing, you agree that your contribution is provided under the
repository's [GPL-3.0 license](LICENSE).
