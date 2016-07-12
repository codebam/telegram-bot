import logging
import time
from telegram.ext import Updater
from telegram.ext import CommandHandler
#logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
shutUp = False
file_ = open('token')
# token is a file used to hide my token from git
# it contains one line with my token
updater = Updater(token=file_.read().rstrip('\n')
)


dispatcher = updater.dispatcher

def start(bot, update):
    bot.sendMessage(chat_id=update.message.chat_id,text="Hello, I'm your friendly community Penguin. Issue me commands, it's not like I have a choice!")

def repl(bot,update):
    go = True
    bot.sendMessage(chat_id=update.message.chat_id, text="Hi, I'm your daughter!!")
    while go:
        textmsg = raw_input("TALK>> ")
        bot.sendMessage(chat_id=update.message.chat_id, text=textmsg)

def nag(bot, update):
    time.sleep(100)
    bot.sendMessage(chat_id=update.message.chat_id, text="Obama says: Remember, personal hygene is always important in a Capitalist society.")

def say_something(bot,update):
    bot.sendMessage(chat_id=update.message.chat_id, text="something")

def talk(bot, update):
    while True
        time.sleep(1)
        for line in fh:
            pass
        lastline = line
    bot.sendMessage(chat_id=update.message.chat_id, text=lastline)

def desu(bot, update):
    bot.sendMessage(chat_id=update.message.chat_id, text="desu~")

def stop(bot, update):
    True
dispatcher.add_handler(CommandHandler('start',start))
dispatcher.add_handler(CommandHandler('callThePresident', nag))
dispatcher.add_handler(CommandHandler('say_something', say_something))
dispatcher.add_handler(CommandHandler('converse', repl))
dispatcher.add_handler(CommandHandler('talk', talk))

updater.start_polling()

