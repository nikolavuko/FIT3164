from flask import Flask, render_template, send_from_directory 
import os

# Serve files in "public/" at the root URL
app = Flask(__name__, static_folder="public", template_folder=".")

@app.route("/")
def index():
    return render_template("index.html")   # your homepage

@app.route("/elo_line_chart")
def elo_line_chart():
    return render_template("elo_line_chart.html")  # chart page

@app.route("/rankings.json")
def rankings():
    return send_from_directory(os.path.join(app.root_path, "public"), "rankings.json")


if __name__ == "__main__":
    app.run(debug=True)
