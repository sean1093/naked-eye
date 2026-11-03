# naked-eye

Give LLMs only the text a human can see.

Web pages, emails and documents can carry instructions that are invisible on
screen but plain to a model: white-on-white text, zero-size fonts, off-screen
elements, HTML comments, Unicode tag characters. `naked-eye` takes HTML and
returns only the text a sighted human would see, plus a report of everything it
removed and why, so agents and RAG pipelines stop acting on hidden prompt
injections.

> **Status:** under active development. The plan is tracked in the
> [v0.1.0 milestone](https://github.com/sean1093/naked-eye/milestone/1).

## Threat model

What `naked-eye` guarantees, what it does not, and how to choose between static
and browser mode:
[docs/threat-model.md](https://github.com/sean1093/naked-eye/blob/main/docs/threat-model.md).

## License

[MIT](LICENSE)
