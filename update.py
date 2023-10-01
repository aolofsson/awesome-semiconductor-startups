#1. Read startups and alumni csv into lists
#2. Read in README line by line and
#3. Insert formatted tables after reference to csv

import os
import csv
import re

def main():

    # Read in CSV files
    startups = list(csv.DictReader(open("startups.csv", "r"), delimiter=","))
    alumni = list(csv.DictReader(open("alumni.csv", "r"), delimiter=","))

    # Read in README
    with open('header.md') as f:
        header = f.read().splitlines()

    # Insert csv lists
    with open('README.md', 'w') as f:

        ################################
        # Printing out old README header
        ################################
        for line in header:
            print(line, file=f)

        ################################
        # Printing out all startups
        ################################
        print("\n## Startups", file=f)
        print("\n| Company | Technology | Founded | Country | Description |", file=f)
        print("|---------|------------|---------|---------|-------------|", file=f)
        for x in startups:
            print(f"|[{x['Company']}](https://{x['Website']}) | {x['Technology']} | {x['Country']} | {x['Founded']} |{x['Description']} |", file=f)

        ################################
        # Printing out exits
        ################################
        print("\n## Alumni", file=f)
        print("\n| Company |  Exit   | Year   | Value | Link |", file=f)
        print("|---------| ------- | ------ | ------|------|", file=f)
        for x in alumni:
            if not re.search(r'http', x['Link']):
                link = "NA"
            else:
                link = f"[Source]({x['Link']})"
            print(f"|{x['Company']} | {x['Exit']} | {x['Year']} | {x['Value']} | {link} |", file=f)

if __name__ == '__main__':
    main()
