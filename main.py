#!/usr/bin/env python3
from uuid import uuid4

import time
import re
import json

from telegram import InlineQueryResultArticle, ParseMode, \
    InputTextMessageContent
from telegram.ext import Updater, InlineQueryHandler, CommandHandler, MessageHandler, Filters

# Local Modules

import inline_query
import escape_markdown
import echo


def start(bot, update):
    bot.sendMessage(chat_id=update.message.chat_id,text="Hello, I'm your friendly community Penguin. Issue me commands, it's not like I have a choice!")


def help(bot, update):
    bot.sendMessage(update.message.chat_id, text='Help!')


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

    dp.add_handler(InlineQueryHandler(inline_query))

    echo_handler = MessageHandler([Filters.text], echo)
    dp.add_handler(echo_handler)

    updater.start_polling()

    updater.idle()

if __name__ == '__main__':
    main()
