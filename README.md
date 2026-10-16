# Kueria - Web-based PostgreSQL Environment for Students

## Overview

Kueria provides a simple, self-contained PostgreSQL environment designed for educational purposes. It allows students to interact with their own isolated PostgreSQL database through a web interface, without needing to install or configure a database server on their personal computers.

The entire environment runs within Docker, making setup and management straightforward for instructors. Each student is given their own user account and a dedicated database, keeping each student’s data separate.

---

## Features

* **Zero Local Installation**: Students only need a web browser. All server components run in Docker.
* **Isolated Environments**: Each student gets a unique PostgreSQL user and a private database named after them, with access restricted to its owner. Shared server resources have configurable limits.
* **Web-based SQL Editor**: A user-friendly interface for writing and executing SQL queries, managing schemas, and viewing results.
* **Simple Administration**: A set of command-line scripts for instructors to easily create, list, and delete student accounts.

---

## Prerequisites

* Docker
* Docker Compose

---

## Installation and Setup

1.  **Clone the Repository**
    Clone this project to your local machine.

2.  **Configure Environment**
    Create a configuration file by copying the example file:
    ```sh
    cp .env.example .env
    ```
    Open the newly created `.env` file and set a secure password for `POSTGRES_PASSWORD`. This password is for the main PostgreSQL administrator (`postgres` user) and is required to manage the database instance. The web interface refuses superuser logins, so administration happens only through the scripts below.

3.  **Build and Run the Environment**
    From the root directory of the project, run the following command to build the Docker images and start the services in the background:
    ```sh
    docker compose up --build -d
    ```
    This will start two services: the PostgreSQL database and the Kueria web application backend. The web interface will be available at `http://localhost:3000` by default.

---

## Usage

### Administrator (Instructor) Guide

All administrative tasks are performed using the provided shell scripts from your terminal.

* **Create a Student Account**
    To create a new user and a corresponding database for a student, run:
    ```sh
    ./scripts/create-student.sh <student_username> <student_password>
    ```
    For example:
    ```sh
    ./scripts/create-student.sh alice strongpassword123
    ```
    This command creates a user named `alice` and a database also named `alice`, owned by that user. Passwords are passed through PostgreSQL’s literal quoting, so spaces and punctuation are supported. Repeating the command repairs partial setup without changing an existing password. SQL or Docker errors stop the script immediately.

    Newly provisioned roles default to 4 MB of working memory per sort/hash operation and a 64 MB temporary-file limit. Rerun the script to apply these defaults to existing students; reconnect their web sessions afterward.

* **List Student Accounts**
    To see a list of all created student users, run:
    ```sh
    ./scripts/list-students.sh
    ```
    This script lists ordinary login roles that own a database with the same name.

* **Delete a Student Account**
    To permanently remove a student's user and their entire database, run:
    ```sh
    ./scripts/delete-student.sh <student_username>
    ```
    This action disconnects active student sessions and permanently deletes their database and role. It is irreversible.

* **Access a Student's Database Directly**
    If you need to inspect or manage a student's database directly via the command line, use:
    ```sh
    ./scripts/sql-student.sh <student_username>
    ```
    This will open an interactive `psql` session connected to the specified student's database.

### Student Guide

1.  **Access Kueria**
    Open your web browser and navigate to the URL provided by your instructor (e.g., `http://localhost:3000`).

2.  **Connect to Your Database**
    On the login screen, enter the username and password assigned to you by your instructor. Click the "Connect" button.

3.  **Use the Interface**
    Once connected, you will see the main interface which includes:
    * **Schema & Table List (Left Panel)**: View your database schemas and tables. You can also create new schemas here.
    * **Query Editor (Right Panel)**: Write your SQL queries in the text area.
    * **Execute Query**: Click the "Execute Query" button to run your code.
    * **Results Panel**: The results of your query will appear at the bottom, displayed in a table.

---

## SQL scripts and transactions

Execute accepts multiple statements and displays a separate result for each statement. Statements use PostgreSQL’s normal transaction rules. You can also execute `BEGIN`, make changes over several Execute clicks, and then execute `COMMIT` or `ROLLBACK`; a web session keeps the same database connection throughout.

After an error inside a transaction, run `ROLLBACK` (or `ROLLBACK TO SAVEPOINT`) before continuing. The results header indicates an open transaction. Reloading a tab restores its existing session without consuming another connection slot. Disconnecting, closing an expired session, or losing the connection rolls back uncommitted work. Sessions close after 30 minutes without requests and at most twelve hours after login, returning the browser to the login screen; idle open transactions are terminated after two minutes.

Large results display only a bounded set of rows and include a truncation notice. Truncation limits displayed data; the SQL statement still executes normally, including all its writes. A separate cancellation connection enforces the query deadline even if a script changes PostgreSQL’s own timeout setting.

## Classroom limits

Configure these values in `.env` and recreate the app container to apply changes:

| Setting | Default | Purpose |
| --- | ---: | --- |
| `MAX_SESSIONS` | 40 | Active and pending web sessions across the server |
| `MAX_SESSIONS_PER_USER` | 2 | Active and pending sessions per student |
| `QUERY_TIMEOUT_MS` | 10000 | Deadline for one submitted SQL script |
| `MAX_RESULT_ROWS` | 1000 | Total displayed rows across a script’s results |
| `MAX_RESULT_BYTES` | 1048576 | Budget for displayed row data |
| `MAX_SQL_BYTES` | 65536 | SQL text size per submission |
| `MAX_STATEMENTS` | 100 | Statements per submission |

Each session uses one persistent connection, with a temporary second connection when cancellation is needed. Keep `MAX_SESSIONS` below half PostgreSQL’s available connection slots to leave room for cancellation and administration. These controls bound connections, query duration, and displayed results; all students still share database CPU and storage.

The app image uses Node 24 and installs runtime dependencies from `backend/package-lock.json`. Source changes require a rebuild with `docker compose up --build -d`. The standard Compose setup runs the built image without source or dependency volume overrides.

## Development and tests

With Node 24 installed, run `npm ci` and `npm test` from `backend`. Use `npm run dev` for Node’s built-in file watcher. The backend accepts `PGHOST` and `PGPORT` when connecting to a separately managed development database.

Run the complete test suite against an isolated PostgreSQL 16 server:

```sh
docker compose -p kueria-tests -f compose.test.yml up --build --abort-on-container-exit --exit-code-from tests
docker compose -p kueria-tests -f compose.test.yml down --volumes
```

The test stack uses its own network and containers, exposes no ports, and has no access to student data. GitHub Actions runs the same suite. Instructor scripts accept `POSTGRES_CONTAINER` to target a separately named database container.

## Stopping the Environment

To stop all running services, execute the following command in the project's root directory:
```sh
docker compose down
```

This will stop the containers, but any data in the database will be preserved in a Docker volume, so student work will not be lost. To start the services again, simply run docker compose up --build -d.

## License

This project is licensed under the MIT License.
