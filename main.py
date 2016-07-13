#!/usr/bin/env python3

import time
import re
import json

from uuid import uuid4
from telegram import InlineQueryResultArticle, ParseMode, \
    InputTextMessageContent
from telegram.ext import Updater, InlineQueryHandler, CommandHandler, MessageHandler, Filters


def start(bot, update):
    bot.sendMessage(chat_id=update.message.chat_id,text="Hello, I'm your friendly community Penguin. Issue me commands, it's not like I have a choice!")


def help(bot, update):
    bot.sendMessage(update.message.chat_id, text='Help!')


def debug(bot, update, args):
    bot.sendMessage(update.message.chat_id, text=str(args))


def main():
    file_ = open('token')
    try:
        token_=file_.read().rstrip('\n')
    finally:
        file_.close()
    # token is a file used to hide my token from git
    # it contains one line with my token

    updater = Updater(token=token_)
    dp = updater.dispatcher
    dp.add_handler(CommandHandler('start', start))
    dp.add_handler(CommandHandler('help', help))
    dp.add_handler(CommandHandler('debug-'+token_, debug, pass_args=True))


    # Local Modules
    from modules import inline_query
    from modules import escape_markdown
    dp.add_handler(InlineQueryHandler(inline_query.inline_query))

    from modules import echo
    echo_handler = MessageHandler([Filters.text], echo.echo)
    dp.add_handler(echo_handler)
    # ---

    updater.start_polling()
    updater.idle()

if __name__ == '__main__':
    main()
