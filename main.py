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
    from modules.inline_query import inline_query
    from modules.escape_markdown import escape_markdown
    dp.add_handler(InlineQueryHandler(inline_query))

    from modules.echo import echo
    echo_handler = MessageHandler([Filters.text], echo)
    dp.add_handler(echo_handler)

    from modules.say_something import say_something
    dp.add_handler(CommandHandler('say_something', say_something))
    # ---

    updater.start_polling()
    updater.idle()

if __name__ == '__main__':
    main()
