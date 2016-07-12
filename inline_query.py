def inline_query(bot, update):
    query = update.inline_query.query
    results = list()
    results.append(InlineQueryResultArticle(id=uuid4(),
                                            title="Bold",
                                            input_message_content=InputTextMessageContent(
                                                "*%s*" % escape_markdown(query),
                                                parse_mode=ParseMode.MARKDOWN)))

    results.append(InlineQueryResultArticle(id=uuid4(),
                                            title="Italic",
                                            input_message_content=InputTextMessageContent(
                                                "_%s_" % escape_markdown(query),
                                                parse_mode=ParseMode.MARKDOWN)))

    results.append(InlineQueryResultArticle(id=uuid4(),
                                            title="Monospace",
                                            input_message_content=InputTextMessageContent(
                                                "`%s`" % escape_markdown(query),
                                                parse_mode=ParseMode.MARKDOWN)))

    bot.answerInlineQuery(update.inline_query.id, results=results)
